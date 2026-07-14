// 各模块共享的可变状态。全部导出「对象引用」，改字段即可，无需重新赋值。
// 好处：所有模块看到的都是同一份，改动最小。

export const params = {
  force: 3.5,
  size: 92,
  strength: 1,
  spin: 1,
  gravity: 450,
  linearDamping: 0.04,
  angularDamping: 0.01,
  volume: 65,
};

// UI/掷骰会话相关的运行时状态。preset 是当前材质预设名，pendingRoll/resultDisplayedForRoll
// 由 main.roll 与 startStableResultWatcher / renderResults 共享。
export const ui = {
  preset: 'astralsea',
  pendingRoll: null,
  resultDisplayedForRoll: false,
};
