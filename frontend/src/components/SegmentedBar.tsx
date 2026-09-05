import {
  INFRA_COLOR,
  OTHER_COLOR,
  UsageBar,
} from '../resources/UsageBar';

/**
 * The one bar shape used for host resources: what this manager's stacks use,
 * then everything else on the machine, then free space.
 *
 * Both fractions are of the whole machine, so the caller passes shares rather
 * than a used total and a subtraction, and the "everything else" segment can
 * never render negative.
 */
export function SegmentedBar({
  ours,
  other,
  height,
}: {
  ours: number;
  other: number;
  height?: number;
}) {
  return (
    <UsageBar
      segments={[
        { fraction: ours, color: INFRA_COLOR },
        { fraction: Math.max(0, other), color: OTHER_COLOR },
      ]}
      height={height}
    />
  );
}
