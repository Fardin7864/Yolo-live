import { GAME_HTML } from './generated/GameBundle';
import type { GameId } from './GameMessageTypes';

export interface RegisteredGame {
  id: GameId;
  title: string;
  route: string;
}

export const REGISTERED_GAMES: Record<GameId, RegisteredGame> = {
  greedy_lion: { id: 'greedy_lion', title: 'Populer Greedy', route: '/main/game/greedy_lion' },
  greedy_pro: { id: 'greedy_pro', title: 'Greedy King', route: '/main/game/greedy_pro' },
  tin_patti_pro: { id: 'tin_patti_pro', title: 'Teen Patti Pro', route: '/main/game/tin_patti_pro' },
  lucky_dice: { id: 'lucky_dice', title: 'Lucky Dice Royale', route: '/main/game/lucky_dice' },
  crash: { id: 'crash', title: 'Crash', route: '/main/game/crash' },
};

export function getGameHtml(gameId: GameId, options: { fillContainer?: boolean } = {}) {
  if (!REGISTERED_GAMES[gameId]) throw new Error(`Unknown game: ${gameId}`);
  const html = GAME_HTML
    .replace('__GAME_ID_VALUE__', gameId)
    .replace(
      '<script>window.__GAME_ID__=',
      `<script>window.__GAME_EMBEDDED__=${options.fillContainer === true};window.__GAME_ID__=`,
    );
  if (!options.fillContainer) return html;
  return html.replace(
    'canvas{display:block;outline:none}',
    'canvas{display:block;outline:none;width:100%!important;height:100%!important}',
  );
}
