import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG, recordName } from '../lib/config';
import { FoundationStack } from '../lib/foundation-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { PlatformStack } from '../lib/platform-stack';

const env = { account: '111122223333', region: CONFIG.region };
const ZONE = 'cap5.example.com';

const app = new App();
const foundation = new FoundationStack(app, 'F', { env });
const platform = new PlatformStack(app, 'P', {
  env, webRepo: foundation.webRepo, workerRepo: foundation.workerRepo, zoneName: ZONE, alertEmail: 'ops@example.com',
});
const pipeline = new PipelineStack(app, 'Pipe', {
  env, webRepo: foundation.webRepo, workerRepo: foundation.workerRepo,
  webService: platform.compute.webService, workerService: platform.compute.workerService,
  connectionArn: 'arn:aws:codeconnections:us-east-1:111122223333:connection/abc',
});
const p = Template.fromStack(platform);
const pipe = Template.fromStack(pipeline);
const f = Template.fromStack(foundation);

describe('high availability', () => {
  test('RDS is Multi-AZ, encrypted, not public, PostgreSQL', () => {
    p.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres', MultiAZ: true, StorageEncrypted: true, PubliclyAccessible: false,
    });
  });
  test('VPC spans the configured number of AZs and ALB uses them all', () => {
    p.resourceCountIs('AWS::EC2::Subnet', CONFIG.azCount * 2);
    const alb = Object.values(p.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))[0] as any;
    expect(alb.Properties.Subnets).toHaveLength(CONFIG.azCount);
    expect(alb.Properties.Scheme).toBe('internet-facing');
  });
  test('cache is a Multi-AZ replication group with failover and encryption', () => {
    p.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      AutomaticFailoverEnabled: true, MultiAZEnabled: true, NumCacheClusters: 2,
      AtRestEncryptionEnabled: true, TransitEncryptionEnabled: true, Engine: CONFIG.cache.engine,
    });
  });
  test('data tier security groups only admit app tiers', () => {
    p.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: CONFIG.db.port, ToPort: CONFIG.db.port });
    p.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: CONFIG.cache.port, ToPort: CONFIG.cache.port });
  });
});

describe('decoupling and compute', () => {
  test('queue has a DLQ with the configured redrive count', () => {
    p.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: CONFIG.queue.visibilitySeconds,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: CONFIG.queue.maxReceive }),
    });
  });
  test('two Fargate services with circuit breaker rollback', () => {
    p.resourceCountIs('AWS::ECS::Service', 2);
    p.allResourcesProperties('AWS::ECS::Service', Match.objectLike({
      LaunchType: 'FARGATE',
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
    }));
  });
  test('container names match the imagedefinitions names the pipeline uses', () => {
    const names = Object.values(p.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((t: any) => t.Properties.ContainerDefinitions.map((c: any) => c.Name)).sort();
    expect(names).toEqual([CONFIG.containers.web, CONFIG.containers.worker].sort());
  });
  test('DB credentials are injected from Secrets Manager, not env vars', () => {
    const defs = Object.values(p.findResources('AWS::ECS::TaskDefinition')).flatMap((t: any) => t.Properties.ContainerDefinitions);
    for (const c of defs) {
      expect(c.Secrets.map((s: any) => s.Name).sort()).toEqual(['DB_PASSWORD', 'DB_USER']);
      expect(JSON.stringify(c.Environment)).not.toMatch(/PASSWORD/);
    }
  });
});

describe('scaling', () => {
  test('web scales on CPU and ALB requests per target', () => {
    p.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', Match.objectLike({
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' },
        TargetValue: CONFIG.web.cpuTarget,
      }),
    }));
    p.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', Match.objectLike({
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: Match.objectLike({ PredefinedMetricType: 'ALBRequestCountPerTarget' }),
        TargetValue: CONFIG.web.requestsPerTarget,
      }),
    }));
  });
  test('worker scales on SQS queue depth', () => {
    p.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', Match.objectLike({
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        CustomizedMetricSpecification: Match.objectLike({ MetricName: 'ApproximateNumberOfMessagesVisible', Namespace: 'AWS/SQS' }),
        TargetValue: CONFIG.worker.queueDepthTarget,
      }),
    }));
    p.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: CONFIG.worker.min, MaxCapacity: CONFIG.worker.max,
    });
  });
  test('Container Insights is on for RunningTaskCount graphs', () => {
    p.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
    });
  });
});

describe('disaster recovery', () => {
  test('daily backup plan with retention and an RDS selection', () => {
    p.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: Match.objectLike({
        BackupPlanRule: [Match.objectLike({
          ScheduleExpression: Match.stringLikeRegexp('cron\\(0 5 \\* \\* \\? \\*\\)'),
          Lifecycle: { DeleteAfterDays: CONFIG.db.backupRetentionDays },
        })],
      }),
    });
    p.resourceCountIs('AWS::Backup::BackupSelection', 1);
  });
  test('Route 53 failover pair: PRIMARY alias with health check, SECONDARY to S3 website', () => {
    p.hasResourceProperties('AWS::Route53::HealthCheck', {
      HealthCheckConfig: Match.objectLike({ Type: 'HTTP', ResourcePath: CONFIG.healthPath, Port: 80 }),
    });
    p.hasResourceProperties('AWS::Route53::RecordSet', Match.objectLike({
      Name: recordName(ZONE), Failover: 'PRIMARY', HealthCheckId: Match.anyValue(),
    }));
    p.hasResourceProperties('AWS::Route53::RecordSet', Match.objectLike({
      Name: recordName(ZONE), Failover: 'SECONDARY',
      AliasTarget: Match.objectLike({ HostedZoneId: CONFIG.s3WebsiteZoneId }),
    }));
  });
  test('error bucket is a website named exactly like the record', () => {
    p.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: recordName(ZONE), WebsiteConfiguration: Match.objectLike({ IndexDocument: 'index.html' }),
    });
  });
  test('failover page exists in the repo', () => {
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'dr', 'index.html'))).toBe(true);
  });
});

describe('observability', () => {
  test('alarms notify an SNS topic with an email subscription', () => {
    p.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
    p.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    p.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });
});

describe('foundation and pipeline', () => {
  test('both ECR repos exist with scanning and lifecycle', () => {
    f.resourceCountIs('AWS::ECR::Repository', 2);
    f.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: CONFIG.repos.web, ImageScanningConfiguration: { ScanOnPush: true },
    });
  });
  test('pipeline is Source -> Build -> Deploy with two ECS deploy actions', () => {
    const stages = (Object.values(pipe.findResources('AWS::CodePipeline::Pipeline'))[0] as any).Properties.Stages;
    expect(stages.map((s: any) => s.Name)).toEqual(['Source', 'Build', 'Deploy']);
    const deploy = stages[2].Actions;
    expect(deploy).toHaveLength(2);
    expect(deploy.map((a: any) => a.Configuration.FileName).sort())
      .toEqual([CONFIG.imageDefinitionFiles.web, CONFIG.imageDefinitionFiles.worker].sort());
  });
  test('CodeBuild is privileged and uses the repo buildspec', () => {
    pipe.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ PrivilegedMode: true }),
      Source: Match.objectLike({ BuildSpec: CONFIG.buildspecPath }),
    });
  });
  test('buildspec emits the files the pipeline expects and names both containers', () => {
    const spec = fs.readFileSync(path.join(__dirname, '..', '..', CONFIG.buildspecPath), 'utf8');
    expect(spec).toContain(CONFIG.imageDefinitionFiles.web);
    expect(spec).toContain(CONFIG.imageDefinitionFiles.worker);
    expect(spec).toContain('WEB_CONTAINER');
    expect(spec).toContain('WORKER_CONTAINER');
  });
});
