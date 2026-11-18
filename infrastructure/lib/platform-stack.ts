import { CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { CONFIG } from './config';
import { Compute } from './constructs/compute';
import { DataTier } from './constructs/data';
import { DisasterRecovery } from './constructs/disaster-recovery';
import { Monitoring } from './constructs/monitoring';
import { Network } from './constructs/network';

export interface PlatformStackProps extends StackProps {
  webRepo: ecr.IRepository;
  workerRepo: ecr.IRepository;
  zoneName: string;
  alertEmail: string;
  imageTag?: string;
}

export class PlatformStack extends Stack {
  readonly compute: Compute;
  readonly data: DataTier;
  readonly dr: DisasterRecovery;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const net = new Network(this, 'Network');
    this.data = new DataTier(this, 'Data', net);
    this.compute = new Compute(this, 'Compute', {
      net, data: this.data, webRepo: props.webRepo, workerRepo: props.workerRepo,
      imageTag: props.imageTag ?? CONFIG.bootstrapTag,
    });
    this.dr = new DisasterRecovery(this, 'Dr', { zoneName: props.zoneName, db: this.data.db, alb: this.compute.alb });
    new Monitoring(this, 'Monitoring', { email: props.alertEmail, compute: this.compute, data: this.data, dr: this.dr });

    const out = (id: string, value: string, description: string) => new CfnOutput(this, id, { value, description });
    out('AlbDnsName', this.compute.alb.loadBalancerDnsName, 'Direct ALB address');
    out('SiteUrl', `http://${this.dr.fqdn}`, 'Failover-protected URL');
    out('NameServers', Fn.join(' ', this.dr.zone.hostedZoneNameServers!), 'Add these as NS records for the delegated subdomain at your DNS host');
    out('QueueUrl', this.data.queue.queueUrl, 'Work queue');
    out('DlqUrl', this.data.dlq.queueUrl, 'Dead letter queue');
    out('ClusterName', this.compute.cluster.clusterName, 'ECS cluster');
    out('WebServiceName', this.compute.webService.serviceName, 'Web service');
    out('WorkerServiceName', this.compute.workerService.serviceName, 'Worker service');
    out('DbInstanceId', this.data.db.instanceIdentifier, 'RDS instance (failover drill)');
    out('DbArn', this.data.db.instanceArn, 'RDS ARN (on-demand backup)');
    out('VaultName', this.dr.vault.backupVaultName, 'Backup vault');
    out('BackupRoleArn', this.dr.backupRole.roleArn, 'Role used by AWS Backup');
    out('HealthCheckId', this.dr.healthCheck.attrHealthCheckId, 'Route 53 health check');
    out('HostedZoneId', this.dr.zone.hostedZoneId, 'Delegated hosted zone');
    out('ErrorBucket', this.dr.errorBucket.bucketName, 'Static error page bucket');
    out('Dashboard', `https://${CONFIG.region}.console.aws.amazon.com/cloudwatch/home?region=${CONFIG.region}#dashboards:name=${CONFIG.project}-platform`, 'CloudWatch dashboard');
  }
}
