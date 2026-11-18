import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { CONFIG } from '../config';

/** Two-AZ VPC. Public subnets hold the ALB and the Fargate tasks (no NAT gateway, to keep
 *  cost down); the data tier lives in isolated subnets with no route to the internet. */
export class Network extends Construct {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly webSg: ec2.SecurityGroup;
  readonly workerSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;
  readonly cacheSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: CONFIG.azCount,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    // Private AWS APIs are still reached through the public subnets' internet route, but
    // S3 traffic (ECR layers) stays on the AWS network.
    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    const sg = (name: string, description: string) =>
      new ec2.SecurityGroup(this, name, { vpc: this.vpc, description, allowAllOutbound: true });

    this.albSg = sg('AlbSg', 'Public ALB');
    this.webSg = sg('WebSg', 'Web tasks');
    this.workerSg = sg('WorkerSg', 'Worker tasks');
    this.dbSg = sg('DbSg', 'PostgreSQL');
    this.cacheSg = sg('CacheSg', 'Valkey cache');

    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet and Route 53 health checkers');
    this.webSg.addIngressRule(this.albSg, ec2.Port.tcp(CONFIG.webPort), 'ALB to web tasks');
    this.dbSg.addIngressRule(this.webSg, ec2.Port.tcp(CONFIG.db.port), 'web to db');
    this.dbSg.addIngressRule(this.workerSg, ec2.Port.tcp(CONFIG.db.port), 'worker to db');
    this.cacheSg.addIngressRule(this.webSg, ec2.Port.tcp(CONFIG.cache.port), 'web to cache');
  }
}
