const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

const { scoreTikTokCandidate } = require('../../src/services/tiktokCompareService');

const datasetPath = path.join(__dirname, 'golden_dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

let tp = 0; // expected exact/similar & eligible
let fp = 0; // expected wrong & eligible
let tn = 0; // expected wrong & rejected
let fn = 0; // expected exact/similar & rejected

const perCategory = {};
const failures = [];

let idx = 0;
for (const row of dataset) {
  idx++;
  const candidate = {
    id: String(1738459399426000000 + idx),
    title: row.targetTitle,
    detail_link: `https://shop.tiktok.com/view/product/${1738459399426000000 + idx}?region=VN&local=en`,
    sales_price: { minimum_amount: String(row.targetPrice), maximum_amount: String(row.targetPrice) },
    original_price: { minimum_amount: String(row.targetPrice), maximum_amount: String(row.targetPrice) },
    has_inventory: true,
    units_sold: 100
  };

  const res = scoreTikTokCandidate(row.sourceTitle, row.sourcePrice, candidate);
  const isPositiveExpected = row.expected === 'exact' || row.expected === 'similar';
  const predictedPositive = Boolean(res.eligible);

  if (!perCategory[row.category]) {
    perCategory[row.category] = { total: 0, correct: 0, fp: 0, fn: 0 };
  }
  perCategory[row.category].total++;

  if (isPositiveExpected && predictedPositive) {
    tp++;
    perCategory[row.category].correct++;
  } else if (!isPositiveExpected && !predictedPositive) {
    tn++;
    perCategory[row.category].correct++;
  } else if (!isPositiveExpected && predictedPositive) {
    fp++;
    perCategory[row.category].fp++;
    failures.push({ ...row, type: 'FALSE_POSITIVE', score: res.score, tier: res.matchTier || res.matchQuality, reason: res.reason });
  } else {
    fn++;
    perCategory[row.category].fn++;
    failures.push({ ...row, type: 'FALSE_NEGATIVE', score: res.score, tier: res.matchTier || res.matchQuality, reason: res.reason });
  }
}

const total = dataset.length;
const totalWrong = fp + tn;
const totalPos = tp + fn;
const precision = tp + fp > 0 ? (tp / (tp + fp)) * 100 : 100;
const recall = totalPos > 0 ? (tp / totalPos) * 100 : 100;
const fpr = totalWrong > 0 ? (fp / totalWrong) * 100 : 0;
const accuracy = ((tp + tn) / total) * 100;

console.log('=== PRICE COMPARISON MATCHING BENCHMARK ===');
console.log(`Dataset size: ${total} pairs (${totalPos} positive, ${totalWrong} wrong)`);
console.log(`Accuracy:            ${accuracy.toFixed(1)}% (${tp + tn}/${total})`);
console.log(`Precision:           ${precision.toFixed(1)}% (${tp}/${tp + fp})`);
console.log(`Recall:              ${recall.toFixed(1)}% (${tp}/${totalPos})`);
console.log(`False Positive Rate: ${fpr.toFixed(1)}% (${fp}/${totalWrong})`);
console.log('\nBy Category:');
for (const [cat, stats] of Object.entries(perCategory)) {
  console.log(`  - ${cat.padEnd(12)}: ${stats.correct}/${stats.total} correct (FP=${stats.fp}, FN=${stats.fn})`);
}

if (failures.length > 0) {
  console.log(`\nFailures (${failures.length}):`);
  for (const f of failures) {
    console.log(`  [${f.type}] ${f.id} (score=${f.score}, reason=${f.reason}): ${f.note}`);
  }
}

if (process.argv.includes('--strict')) {
  if (precision < 90 || fpr > 8 || recall < 90) {
    console.error('\nSTRICT BENCHMARK FAILED: requires Precision >= 90%, FPR <= 8%, Recall >= 90%');
    process.exit(1);
  }
  console.log('\nSTRICT BENCHMARK PASSED!');
}
