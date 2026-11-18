import { Duration } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { CONFIG } from '../config';
import { Compute } from './compute';
import { DataTier } from './data';
import { DisasterRecovery } from './disaster-recovery';

export class Monitoring extends Construct {
  readonly topic: sns.Topic;
  readonly dashboard: cw.Dashboard;

  constructor(scope: Construct, id: string, p: { email: string; compute: Compute; data: DataTier; dr: DisasterRecovery }) {
    super(scope, id);
    const { compute, data, dr } = p;

    this.topic = new sns.Topic(this, 'Alerts', { displayName: `${CONFIG.project} alerts` });
    this.topic.addSubscription(new subs.EmailSubscription(p.email));
    const notify = new cwActions.SnsAction(this.topic);

    const running = (svc: string) =>
      new cw.Metric({
        namespace: 'ECS/ContainerInsights', metricName: 'RunningTaskCount', statistic: 'Average',
        period: Duration.minutes(1),
        dimensionsMap: { ClusterName: compute.cluster.clusterName, ServiceName: svc },
        label: svc,
      });
    const workerRunning = running(compute.workerService.serviceName);
    const webRunning = running(compute.webService.serviceName);
    const depth = data.queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), label: 'Queue depth (visible)' });
    const dlqDepth = data.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), label: 'DLQ depth' });
    const requests = compute.targetGroup.metrics.requestCount({ period: Duration.minutes(1), statistic: 'Sum', label: 'ALB requests' });
    const target5xx = compute.targetGroup.metrics.httpCodeTarget(
      elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
      { period: Duration.minutes(1), statistic: 'Sum', label: 'Target 5xx' });
    const healthy = compute.targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1), label: 'Healthy targets' });
    const r53 = new cw.Metric({
      namespace: 'AWS/Route53', metricName: 'HealthCheckStatus', statistic: 'Minimum', period: Duration.minutes(1),
      dimensionsMap: { HealthCheckId: dr.healthCheck.attrHealthCheckId }, label: 'Route 53 health (1=up)',
    });
    const webCpu = compute.webService.metricCpuUtilization({ period: Duration.minutes(1) });

    const mk = (id: string, metric: cw.IMetric, desc: string, threshold: number, op: cw.ComparisonOperator, periods = 2, missing = cw.TreatMissingData.NOT_BREACHING) => {
      const a = new cw.Alarm(this, id, {
        alarmName: `${CONFIG.project}-${id}`, alarmDescription: desc, metric, threshold,
        comparisonOperator: op, evaluationPeriods: periods, treatMissingData: missing,
      });
      a.addAlarmAction(notify);
      return a;
    };
    mk('DlqNotEmpty', dlqDepth, 'Messages reached the dead letter queue', 1, cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, 1);
    mk('Web5xx', target5xx, 'Web tier returning 5xx', 10, cw.ComparisonOperator.GREATER_THAN_THRESHOLD);
    mk('WebUnhealthy', healthy, 'Fewer than 1 healthy web target', 1, cw.ComparisonOperator.LESS_THAN_THRESHOLD, 2, cw.TreatMissingData.BREACHING);
    mk('Route53Primary', r53, 'Route 53 reports the ALB unhealthy: DNS has failed over to the S3 error page', 1,
      cw.ComparisonOperator.LESS_THAN_THRESHOLD, 1, cw.TreatMissingData.NOT_BREACHING);

    this.dashboard = new cw.Dashboard(this, 'Dashboard', { dashboardName: `${CONFIG.project}-platform` });
    this.dashboard.addWidgets(
      new cw.GraphWidget({ title: 'Worker scaling: queue depth vs running tasks', width: 12, left: [depth], right: [workerRunning] }),
      new cw.GraphWidget({ title: 'Web scaling: ALB requests vs running tasks', width: 12, left: [requests], right: [webRunning] }),
    );
    this.dashboard.addWidgets(
      new cw.GraphWidget({ title: 'Web CPU %', width: 8, left: [webCpu] }),
      new cw.GraphWidget({ title: 'Healthy targets and 5xx', width: 8, left: [healthy, target5xx] }),
      new cw.GraphWidget({ title: 'DR: Route 53 health and DLQ', width: 8, left: [r53], right: [dlqDepth] }),
    );
  }
}
