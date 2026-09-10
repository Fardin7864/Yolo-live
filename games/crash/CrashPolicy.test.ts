import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCrashAction } from './CrashPolicy';

const bet = (status: 'placed' | 'cashed_out' | 'lost' | 'refunded' | 'cancelled') => ({ id: 'b1', amount: 500, status });

test('Crash action matrix never allows late bets or invalid cashouts', () => {
  assert.equal(resolveCrashAction('BETTING_OPEN', null), 'BET');
  assert.equal(resolveCrashAction('BETTING_LOCKED', null), 'WAIT');
  assert.equal(resolveCrashAction('RUNNING', bet('placed')), 'CASH_OUT');
  assert.equal(resolveCrashAction('RUNNING', null), 'WAIT');
  assert.equal(resolveCrashAction('CRASHED', bet('lost')), 'LOST');
  assert.equal(resolveCrashAction('SETTLED', bet('cashed_out')), 'CASHED_OUT');
  assert.equal(resolveCrashAction('VOIDED', bet('refunded')), 'CANCELLED');
});
