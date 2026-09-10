export const GREEDY_LION_WIDTH = 540;
export const GREEDY_LION_HEIGHT = 960;

export const GREEDY_ITEMS = [
  { id: 'corn', label: 'Corn', category: 'salad', texture: 'corn', x: 146, y: 260 },
  { id: 'chicken', label: 'Chicken', category: 'pizza', texture: 'chicken', x: 270, y: 205 },
  { id: 'shrimp', label: 'Shrimp', category: 'pizza', texture: 'shrimp', x: 394, y: 260 },
  { id: 'ham', label: 'Ham', category: 'pizza', texture: 'ham', x: 422, y: 405 },
  { id: 'fish', label: 'Fish', category: 'pizza', texture: 'fish', x: 368, y: 540 },
  { id: 'carrot', label: 'Carrot', category: 'salad', texture: 'carrot', x: 270, y: 585 },
  { id: 'pepper', label: 'Pepper', category: 'salad', texture: 'pepper', x: 172, y: 540 },
  { id: 'tomato', label: 'Tomato', category: 'salad', texture: 'tomato', x: 118, y: 405 },
] as const;

export const CHIP_AMOUNTS = [1000, 5000, 50000, 100000] as const;
