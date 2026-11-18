import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import * as path from 'path';
import { CONFIG, recordName } from '../config';

export interface DrProps {
  zoneName: string;
  db: rds.DatabaseInstance;
  alb: elbv2.ApplicationLoadBalancer;
}

/** AWS Backup daily plan plus Route 53 failover to a static S3 error page. */
export class DisasterRecovery extends Construct {
  readonly vault: backup.BackupVault;
  readonly backupRole: iam.Role;
  readonly zone: route53.PublicHostedZone;
  readonly healthCheck: route53.CfnHealthCheck;
  readonly errorBucket: s3.Bucket;
  readonly fqdn: string;

  constructor(scope: Construct, id: string, p: DrProps) {
    super(scope, id);
    this.fqdn = recordName(p.zoneName);

    // ---- AWS Backup ----
    this.vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: `${CONFIG.project}-vault`,
      removalPolicy: RemovalPolicy.DESTROY, // fails if recovery points remain: see README teardown
    });
    this.backupRole = new iam.Role(this, 'BackupRole', {
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'),
      ],
    });
    const plan = new backup.BackupPlan(this, 'Plan', {
      backupPlanName: `${CONFIG.project}-daily`,
      backupVault: this.vault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'daily-rds',
          scheduleExpression: events.Schedule.cron(CONFIG.dr.backupCron),
          startWindow: Duration.hours(1),
          completionWindow: Duration.hours(2),
          deleteAfter: Duration.days(CONFIG.db.backupRetentionDays),
        }),
      ],
    });
    plan.addSelection('Rds', {
      backupSelectionName: `${CONFIG.project}-rds`,
      role: this.backupRole,
      resources: [backup.BackupResource.fromRdsDatabaseInstance(p.db)],
    });

    // ---- static error page (secondary record target) ----
    // The bucket name must equal the record name for an S3 website alias.
    this.errorBucket = new s3.Bucket(this, 'ErrorSite', {
      bucketName: this.fqdn,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: false,
      }),
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, 'ErrorPage', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', '..', 'dr'))],
      destinationBucket: this.errorBucket,
    });

    // ---- Route 53 ----
    this.zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: p.zoneName });

    this.healthCheck = new route53.CfnHealthCheck(this, 'AlbHealth', {
      healthCheckConfig: {
        type: 'HTTP',
        fullyQualifiedDomainName: p.alb.loadBalancerDnsName,
        port: 80,
        resourcePath: CONFIG.healthPath,
        requestInterval: CONFIG.dr.healthInterval,
        failureThreshold: CONFIG.dr.healthFailures,
      },
      healthCheckTags: [{ key: 'Name', value: `${CONFIG.project}-alb` }],
    });

    new route53.CfnRecordSet(this, 'Primary', {
      hostedZoneId: this.zone.hostedZoneId,
      name: this.fqdn,
      type: 'A',
      setIdentifier: 'primary-alb',
      failover: 'PRIMARY',
      healthCheckId: this.healthCheck.attrHealthCheckId,
      aliasTarget: {
        dnsName: p.alb.loadBalancerDnsName,
        hostedZoneId: p.alb.loadBalancerCanonicalHostedZoneId,
        evaluateTargetHealth: true,
      },
    });
    new route53.CfnRecordSet(this, 'Secondary', {
      hostedZoneId: this.zone.hostedZoneId,
      name: this.fqdn,
      type: 'A',
      setIdentifier: 'secondary-s3',
      failover: 'SECONDARY',
      aliasTarget: {
        dnsName: this.errorBucket.bucketWebsiteDomainName,
        hostedZoneId: CONFIG.s3WebsiteZoneId,
        evaluateTargetHealth: false,
      },
    });
  }
}
