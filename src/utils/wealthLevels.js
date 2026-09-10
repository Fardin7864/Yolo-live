export const WEALTH_LEVEL_COSTS = [
  0,3000,6000,16000,66000,166000,330000,500000,700000,1000000,1100000,1300000,1600000,2000000,2600000,3400000,4400000,
  5600000,7000000,10000000,10500000,11500000,13000000,15000000,18000000,22000000,27000000,33000000,40000000,50000000,
  52000000,55000000,60000000,68000000,79000000,95000000,114000000,137000000,163000000,200000000,204000000,210000000,
  220000000,236000000,258000000,290000000,328000000,375000000,428000000,500000000,506000000,516000000,535000000,
  560000000,598000000,648000000,710000000,785000000,870000000,1000000000,1020000000,1060000000,1120000000,
  1220000000,1360000000,1560000000,1800000000,2100000000,2440000000,3000000000,3020000000,3060000000,3120000000,
  3220000000,3360000000,3560000000,3800000000,4100000000,4440000000,5000000000,5050000000,5150000000,5300000000,
  5550000000,5900000000,6400000000,7000000000,7750000000,8600000000,10000000000,10100000000,10300000000,10600000000,
  11100000000,11800000000,12800000000,14000000000,15500000000,17200000000,20600000000,20710000000,20930000000,
  21260000000,21810000000,22420000000,23100000000,23920000000,24900000000,26050000000,27400000000,
];

export const WEALTH_LEVEL_THRESHOLDS = WEALTH_LEVEL_COSTS.map((min_exp, index) => ({ level: index + 1, min_exp }));

export const wealthVisualForLevel = (level) => {
  if (level <= 4) return { color: '#7BCB37', dark: '#315F17', icon: 'triangle', name: 'Starter' };
  if (level <= 9) return { color: '#F5D11E', dark: '#7A5D00', icon: 'sparkles', name: 'Spark' };
  if (level <= 19) return { color: '#F18A14', dark: '#7A3908', icon: 'moon', name: 'Moon' };
  if (level <= 29) return { color: '#EF5863', dark: '#7C1629', icon: 'flame', name: 'Flame' };
  if (level <= 39) return { color: '#EC2B91', dark: '#79104D', icon: 'star', name: 'Star' };
  if (level <= 49) return { color: '#B92DDD', dark: '#5A1475', icon: 'sunny', name: 'Radiance' };
  if (level <= 59) return { color: '#8B3CD0', dark: '#431B70', icon: 'ribbon', name: 'Medal' };
  if (level <= 69) return { color: '#2E73F0', dark: '#153C91', icon: 'diamond', name: 'Diamond' };
  if (level <= 79) return { color: '#275DC8', dark: '#102E73', icon: 'trophy', name: 'Crown' };
  if (level <= 99) return { color: '#F04431', dark: '#8A170F', icon: 'trophy', name: 'Royal' };
  return { color: '#7A2CCB', dark: '#37106F', icon: 'shield-checkmark', name: 'Legend' };
};

export const deriveWealthLevel = (giftedDiamonds, thresholds = WEALTH_LEVEL_THRESHOLDS) => thresholds.reduce(
  (level, row) => Number(giftedDiamonds || 0) >= Number(row.min_exp) ? Number(row.level) : level,
  1,
);

export const getWealthProgress = (giftedDiamonds, thresholds = WEALTH_LEVEL_THRESHOLDS) => {
  const amount = Math.max(0, Number(giftedDiamonds) || 0);
  const level = deriveWealthLevel(amount, thresholds);
  const current = Number(thresholds.find((row) => Number(row.level) === level)?.min_exp || 0);
  const nextRow = thresholds.find((row) => Number(row.level) === level + 1);
  const next = nextRow ? Number(nextRow.min_exp) : current;
  const progress = nextRow ? Math.max(0, Math.min(100, ((amount - current) / Math.max(1, next - current)) * 100)) : 100;
  return { level, current, next, nextLevel: nextRow ? level + 1 : null, progress, remaining: nextRow ? Math.max(0, next - amount) : 0 };
};
