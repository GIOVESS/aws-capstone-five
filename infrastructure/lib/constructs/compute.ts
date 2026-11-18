import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { CONFIG } from '../config';
import { DataTier } from './data';
import { Network } from './network';

export interface ComputeProps {
  net: Network;
  data: DataTier;
  webRepo: ecr.IRepository;
  workerRepo: ecr.IRepository;
  imageTag: string;
}

/** ECS cluster, ALB, web service (CPU and request scaling), worker service (queue depth scaling). */
export class Compute extends Construct {
  readonly cluster: ecs.Cluster;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly webService: ecs.FargateService;
  readonly workerService: ecs.FargateService;

  constructor(scope: Construct, id: string, p: ComputeProps) {
    super(scope, id);
    const { net, data } = p;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: net.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED, // publishes RunningTaskCount for the scaling graphs
    });

    const logGroup = (name: string) =>
      new logs.LogGroup(this, name, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });

    const dbSecret = data.db.secret!;
    const sharedEnv = {
      DB_HOST: data.db.dbInstanceEndpointAddress,
      DB_PORT: data.db.dbInstanceEndpointPort,
      DB_NAME: CONFIG.db.name,
      QUEUE_URL: data.queue.queueUrl,
      AWS_REGION: CONFIG.region,
    };
    const sharedSecrets = {
      DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
    };
    const publicSubnets = { subnetType: ec2.SubnetType.PUBLIC };

    // ---- web ----
    const webTask = new ecs.FargateTaskDefinition(this, 'WebTask', {
      cpu: CONFIG.web.cpu, memoryLimitMiB: CONFIG.web.memory,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    webTask.addContainer(CONFIG.containers.web, {
      image: ecs.ContainerImage.fromEcrRepository(p.webRepo, p.imageTag),
      portMappings: [{ containerPort: CONFIG.webPort }],
      environment: {
        ...sharedEnv,
        REDIS_HOST: data.cacheEndpoint,
        REDIS_PORT: String(CONFIG.cache.port),
        REDIS_TLS: 'true',
      },
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web', logGroup: logGroup('WebLogs') }),
    });
    data.queue.grantSendMessages(webTask.taskRole);

    this.webService = new ecs.FargateService(this, 'WebService', {
      cluster: this.cluster,
      taskDefinition: webTask,
      desiredCount: CONFIG.web.min,
      securityGroups: [net.webSg],
      vpcSubnets: publicSubnets,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(60),
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: net.vpc, internetFacing: true, securityGroup: net.albSg, vpcSubnets: publicSubnets,
    });
    const listener = this.alb.addListener('Http', { port: 80, open: false });
    this.targetGroup = listener.addTargets('Web', {
      port: CONFIG.webPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.webService],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: CONFIG.healthPath, interval: Duration.seconds(15), timeout: Duration.seconds(5),
        healthyThresholdCount: 2, unhealthyThresholdCount: 2,
      },
    });

    const webScaling = this.webService.autoScaleTaskCount({ minCapacity: CONFIG.web.min, maxCapacity: CONFIG.web.max });
    webScaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: CONFIG.web.cpuTarget,
      scaleOutCooldown: Duration.seconds(60), scaleInCooldown: Duration.seconds(120),
    });
    webScaling.scaleOnRequestCount('Requests', {
      requestsPerTarget: CONFIG.web.requestsPerTarget, targetGroup: this.targetGroup,
      scaleOutCooldown: Duration.seconds(60), scaleInCooldown: Duration.seconds(120),
    });

    // ---- worker ----
    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      cpu: CONFIG.worker.cpu, memoryLimitMiB: CONFIG.worker.memory,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    workerTask.addContainer(CONFIG.containers.worker, {
      image: ecs.ContainerImage.fromEcrRepository(p.workerRepo, p.imageTag),
      environment: { ...sharedEnv, WORKER_THREADS: String(CONFIG.worker.threads), SYNTHETIC_SECONDS: '3' },
      secrets: sharedSecrets,
      stopTimeout: Duration.seconds(60), // drain in-flight messages on scale-in and rolling updates
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup: logGroup('WorkerLogs') }),
    });
    data.queue.grantConsumeMessages(workerTask.taskRole);

    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster: this.cluster,
      taskDefinition: workerTask,
      desiredCount: CONFIG.worker.min,
      securityGroups: [net.workerSg],
      vpcSubnets: publicSubnets,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const workerScaling = this.workerService.autoScaleTaskCount({
      minCapacity: CONFIG.worker.min, maxCapacity: CONFIG.worker.max,
    });
    workerScaling.scaleToTrackCustomMetric('QueueDepth', {
      metric: data.queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Average' }),
      targetValue: CONFIG.worker.queueDepthTarget,
      scaleOutCooldown: Duration.seconds(30),
      scaleInCooldown: Duration.seconds(120),
    });
  }
}
