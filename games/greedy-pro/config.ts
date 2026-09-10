export const GREEDY_LION_WIDTH = 540;
export const GREEDY_LION_HEIGHT = 960;

export const GREEDY_ITEMS = [
  { id: 'chicken', label: 'Chicken', category: 'pizza', texture: 'chicken', x: 270, y: 224 },
  { id: 'shrimp', label: 'Shrimp', category: 'pizza', texture: 'shrimp', x: 389, y: 273 },
  { id: 'ham', label: 'Ham', category: 'pizza', texture: 'ham', x: 438, y: 392 },
  { id: 'fish', label: 'Fish', category: 'pizza', texture: 'fish', x: 389, y: 511 },
  { id: 'tomato', label: 'Tomato', category: 'salad', texture: 'tomato', x: 270, y: 560 },
  { id: 'corn', label: 'Corn', category: 'salad', texture: 'corn', x: 151, y: 511 },
  { id: 'pepper', label: 'Pepper', category: 'salad', texture: 'pepper', x: 102, y: 392 },
  { id: 'carrot', label: 'Carrot', category: 'salad', texture: 'carrot', x: 151, y: 273 },
] as const;

export const CHIP_AMOUNTS = [1000, 5000, 50000, 100000] as const;
