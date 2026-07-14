// 骰子表达式解析 + 掷骰计划 + 结果核对。
// 支持 1d20 / 4d6kh3 / 2d20+5 / 1d100 等。
// buildRollPlan 只生成 notation，不预随机；真正的点数由 reconcilePlanWithLiveDice 从物理骰面读回。

export function parseExpression(expr) {
  const cleanExpr = expr.replace(/\s+/g, '').toLowerCase();
  const termRe = /([+\-]?)(\d*d\d+(?:kh\d+|kl\d+|dh\d+|dl\d+)?|\d+)/g;
  const terms = [];
  let m;
  let matchedLen = 0;

  while ((m = termRe.exec(cleanExpr)) !== null) {
    matchedLen += m[0].length;
    const sign = m[1] === '-' ? -1 : 1;
    const body = m[2];
    const diceMatch = body.match(/^(\d*)d(\d+)(kh|kl|dh|dl)?(\d+)?$/);
    if (diceMatch) {
      const qty = diceMatch[1] === '' ? 1 : Number(diceMatch[1]);
      const sides = Number(diceMatch[2]);
      const modifier = diceMatch[3] || null;
      const modifierN = diceMatch[4] ? Number(diceMatch[4]) : (modifier ? 1 : null);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new Error('骰子数量必须在 1–50 之间');
      if (![4, 6, 8, 10, 12, 20, 100].includes(sides)) throw new Error(`dice-box-threejs 不支持 d${sides}`);
      terms.push({ type: 'dice', sign, qty, sides, modifier, modifierN });
    } else {
      terms.push({ type: 'const', sign, value: Number(body) });
    }
  }

  if (matchedLen !== cleanExpr.length || terms.length === 0) throw new Error(`无法解析表达式：${expr}`);
  return terms;
}

export function buildRollPlan(input) {
  const terms = parseExpression(input);
  const groups = [];
  const notationParts = [];
  let constantTotal = 0;

  for (const term of terms) {
    if (term.type === 'const') {
      constantTotal += term.sign * term.value;
      continue;
    }

    // 不再事先随机，具体值由物理演算后从骰面读回。
    const dice = Array.from({ length: term.qty }, () => ({ sides: term.sides, value: 0, kept: true }));

    if (term.sides === 100) {
      for (let i = 0; i < term.qty; i += 1) {
        notationParts.push(notationParts.length > 0 ? '+1d100' : '1d100');
        notationParts.push('+1d10');
      }
    } else {
      const prefix = notationParts.length > 0 ? '+' : '';
      notationParts.push(`${prefix}${term.qty}d${term.sides}`);
    }

    groups.push({ term, dice });
  }

  return {
    input,
    terms,
    groups,
    constantTotal,
    total: constantTotal,
    libraryNotation: notationParts.length ? notationParts.join('') : '',
  };
}

function readLiveDieValue(liveDie) {
  if (!liveDie) return null;
  const stored = Array.isArray(liveDie.result) && liveDie.result.length > 0
    ? liveDie.result[liveDie.result.length - 1]
    : null;
  const value = stored?.value ?? liveDie.getFaceValue?.()?.value;
  return typeof value === 'number' && value > 0 ? value : null;
}

// 根据物理骰面读回真实点数，重算 kept / 总分。
// dice 顺序与 groups[*].dice[*] 一致；d100 拆成 十位 d100 + 个位 d10 两颗视觉骰子。
export function reconcilePlanWithLiveDice(plan, box) {
  const dice = (box.diceList || []).filter((die) => die?.getFaceValue);
  if (dice.length === 0) return;

  let cursor = 0;
  for (const group of plan.groups) {
    for (const die of group.dice) {
      if (die.sides === 100) {
        const tensDie = dice[cursor++];
        const onesDie = dice[cursor++];
        if (!tensDie || !onesDie) return;
        const tens = readLiveDieValue(tensDie) ?? 0;
        const ones = readLiveDieValue(onesDie) ?? 0;
        const tensNorm = tens === 100 ? 0 : tens;
        const onesNorm = ones === 10 ? 0 : ones;
        let real = tensNorm + onesNorm;
        if (real === 0) real = 100;
        die.value = real;
        die.visual = {
          tensTarget: tensNorm === 0 ? 100 : tensNorm,
          onesTarget: onesNorm === 0 ? 10 : onesNorm,
        };
      } else {
        const liveDie = dice[cursor++];
        if (!liveDie) return;
        const real = readLiveDieValue(liveDie);
        if (real !== null) die.value = real;
      }
    }
  }

  let total = plan.constantTotal;
  for (const group of plan.groups) {
    const term = group.term;
    if (term.modifier) {
      const sorted = group.dice
        .map((die, index) => ({ die, index }))
        .sort((a, b) => b.die.value - a.die.value);
      const n = Math.max(0, Math.min(term.modifierN, group.dice.length));
      let keptIndexes;
      switch (term.modifier) {
        case 'kh': keptIndexes = new Set(sorted.slice(0, n).map((item) => item.index)); break;
        case 'kl': keptIndexes = new Set(sorted.slice(-n).map((item) => item.index)); break;
        case 'dh': keptIndexes = new Set(sorted.slice(n).map((item) => item.index)); break;
        case 'dl': keptIndexes = new Set(sorted.slice(0, group.dice.length - n).map((item) => item.index)); break;
        default: keptIndexes = new Set(group.dice.map((_, index) => index));
      }
      group.dice.forEach((die, index) => { die.kept = keptIndexes.has(index); });
    } else {
      group.dice.forEach((die) => { die.kept = true; });
    }
    total += term.sign * group.dice.filter((die) => die.kept).reduce((sum, die) => sum + die.value, 0);
  }
  plan.total = total;
}
