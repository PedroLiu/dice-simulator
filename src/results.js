// 结果面板渲染：总计大数 + 逐骰 chip（含 dropped 样式和 d100 视觉说明）。
// 想改结果显示样式或结构，来这个文件。

const resultSummaryEl = document.querySelector('#result-summary');
const resultTotalEl = document.querySelector('#result-total .total-value');
const resultDetailEl = document.querySelector('#result-detail');
const statusEl = document.querySelector('#status');

export function showResultSummary(total, detailHtml) {
  resultTotalEl.textContent = String(total);
  resultDetailEl.innerHTML = detailHtml;
  resultSummaryEl.classList.remove('hidden');
}

export function clearResultSummary() {
  resultSummaryEl.classList.add('hidden');
  resultTotalEl.textContent = '0';
  resultDetailEl.innerHTML = '';
}

export function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function flattenResults(results) {
  if (!results) return [];
  if (Array.isArray(results)) return results.flatMap(flattenResults);
  if (Array.isArray(results.rolls)) return results.rolls.flatMap(flattenResults);
  if (Array.isArray(results.set)) return results.set.flatMap(flattenResults);
  if (typeof results === 'object' && 'value' in results) return [results];
  return [];
}

// plan 存在时用我们的 plan（有 kept/modifier 信息）；否则回落到库返回的原始 results。
export function renderResults(results, plan) {
  if (!plan) {
    const values = flattenResults(results);
    if (values.length === 0) {
      setStatus('掷骰完成');
      clearResultSummary();
      return;
    }
    const total = values.reduce((sum, item) => sum + Number(item.value || 0), 0);
    setStatus('掷骰完成');
    const detail = values.map((item) => {
      const type = item.sides ? `d${item.sides}` : (item.type || 'die');
      return `<span class="result-chip"><em>${type}</em><strong>${item.value}</strong></span>`;
    }).join('');
    showResultSummary(total, detail);
    return;
  }

  setStatus('掷骰完成');
  const chips = [];
  for (const group of plan.groups) {
    for (const die of group.dice) {
      const visual = die.sides === 100 && die.visual
        ? `<small>${die.visual.tensTarget === 100 ? '00' : die.visual.tensTarget}+${die.visual.onesTarget === 10 ? '0' : die.visual.onesTarget}</small>`
        : '';
      chips.push(`<span class="result-chip ${die.kept ? '' : 'dropped'}"><em>d${die.sides}</em><strong>${die.value}</strong>${visual}</span>`);
    }
    if (group.term.modifier) {
      chips.push(`<span class="modifier-chip">${group.term.modifier}${group.term.modifierN}</span>`);
    }
  }
  if (plan.constantTotal !== 0) {
    chips.push(`<span class="result-chip"><em>修正</em><strong>${plan.constantTotal > 0 ? '+' : ''}${plan.constantTotal}</strong></span>`);
  }
  showResultSummary(plan.total, chips.join(''));
}
