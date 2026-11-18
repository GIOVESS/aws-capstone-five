import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { CONFIG } from '../config';
import { Network } from './network';

/** RDS Multi-AZ, ElastiCache (Valkey) with a replica in the second AZ, SQS with a DLQ. */
export class DataTier extends Construct {
  readonly db: rds.DatabaseInstance;
  readonly cacheEndpoint: string;
  readonly cache: elasticache.CfnReplicationGroup;
  readonly queue: sqs.Queue;
  readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, net: Network) {
    super(scope, id);
    const isolated = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    this.db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18_3 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: net.vpc,
      vpcSubnets: isolated,
      securityGroups: [net.dbSg],
      multiAz: true,
      allocatedStorage: 20,
      storageEncrypted: true,
      databaseName: CONFIG.db.name,
      credentials: rds.Credentials.fromGeneratedSecret(CONFIG.db.adminUser),
      backupRetention: Duration.days(1), // AWS Backup owns the long-term schedule
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      publiclyAccessible: false,
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'Cache subnets (2 AZs)',
      subnetIds: net.vpc.selectSubnets(isolated).subnetIds,
    });
    this.cache = new elasticache.CfnReplicationGroup(this, 'Cache', {
      replicationGroupDescription: 'cap5 cache-aside store',
      engine: CONFIG.cache.engine,
      engineVersion: CONFIG.cache.engineVersion,
      cacheNodeType: CONFIG.cache.nodeType,
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      port: CONFIG.cache.port,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [net.cacheSg.securityGroupId],
    });
    this.cacheEndpoint = this.cache.attrPrimaryEndPointAddress;

    this.dlq = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout: Duration.seconds(CONFIG.queue.visibilitySeconds),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: CONFIG.queue.maxReceive },
    });
  }
}
