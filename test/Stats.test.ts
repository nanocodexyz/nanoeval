import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Stats from '../src/Stats.ts'

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, actual + ' is not ' + expected)

test('the chance of the passes of one task falling as they did, by hand', () => {
  near(Stats.task({ passed: 3, scored: 3 }, { passed: 0, scored: 3 }).worse, 1 / 20)
  near(Stats.task({ passed: 3, scored: 3 }, { passed: 0, scored: 3 }).better, 1)
  near(Stats.task({ passed: 0, scored: 3 }, { passed: 3, scored: 3 }).better, 1 / 20)
  near(Stats.task({ passed: 2, scored: 3 }, { passed: 1, scored: 3 }).worse, 10 / 20)
  near(Stats.task({ passed: 2, scored: 3 }, { passed: 1, scored: 3 }).better, 19 / 20)
  near(Stats.task({ passed: 1, scored: 1 }, { passed: 0, scored: 1 }).worse, 1 / 2)
  near(Stats.task({ passed: 4, scored: 4 }, { passed: 0, scored: 4 }).worse, 1 / 70)
  near(Stats.task({ passed: 5, scored: 5 }, { passed: 1, scored: 5 }).worse, 6 / 252)
  near(Stats.task({ passed: 2, scored: 2 }, { passed: 1, scored: 3 }).worse, 3 / 10)
  near(Stats.task({ passed: 3, scored: 3 }, { passed: 3, scored: 3 }).worse, 1)
  near(Stats.task({ passed: 0, scored: 2 }, { passed: 0, scored: 2 }).better, 1)
})

test('the same chance over tasks is the sign test with one attempt a side', () => {
  const flip = (down: boolean) => ({
    baseline: { passed: down ? 1 : 0, scored: 1 },
    run: { passed: down ? 0 : 1, scored: 1 },
  })
  const same = { baseline: { passed: 1, scored: 1 }, run: { passed: 1, scored: 1 } }
  near(
    Stats.overall([flip(true), flip(true), flip(true), flip(true), flip(true), same]).worse,
    1 / 32,
  )
  near(Stats.overall([flip(true), flip(true), flip(true), flip(true)]).worse, 1 / 16)
  near(Stats.overall([flip(true), flip(true), flip(true), flip(false), same]).worse, 5 / 16)
  near(Stats.overall([flip(true), flip(true), flip(true), flip(false), same]).better, 15 / 16)
  near(Stats.overall([]).worse, 1)
})

test('over tasks, small moves in one direction add up', () => {
  const down = { baseline: { passed: 2, scored: 3 }, run: { passed: 1, scored: 3 } }
  near(Stats.overall([down]).worse, 1 / 2)
  near(Stats.overall([down, down]).worse, 118 / 400)
  near(
    Stats.overall([
      { baseline: { passed: 3, scored: 3 }, run: { passed: 0, scored: 3 } },
      { baseline: { passed: 1, scored: 3 }, run: { passed: 1, scored: 3 } },
    ]).worse,
    52 / 400,
  )
  near(
    Stats.overall([
      { baseline: { passed: 3, scored: 3 }, run: { passed: 0, scored: 3 } },
      { baseline: { passed: 3, scored: 3 }, run: { passed: 3, scored: 3 } },
    ]).worse,
    1 / 20,
  )
})

test('the smallest chance a task can reach with its attempts', () => {
  near(Stats.floor(1, 1), 1 / 2)
  near(Stats.floor(2, 2), 1 / 6)
  near(Stats.floor(3, 3), 1 / 20)
  near(Stats.floor(3, 2), 1 / 10)
  near(Stats.floor(0, 3), 1)
})
