import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const summary = JSON.parse(
  fs.readFileSync(
    path.join(root, "experiments/llm-export/results/2026-10-12/summary.json"),
    "utf8",
  ),
);
const C = {
  ink: "#192C40",
  muted: "#506176",
  blue: "#235BC5",
  blueBg: "#EDF3FD",
  green: "#147968",
  greenBg: "#ECF6F2",
  line: "#D6DFE8",
  soft: "#F2F5F8",
  amber: "#975B11",
  amberBg: "#FFF5E5",
  red: "#AE3D43",
  redBg: "#FCEEF0",
  white: "#FFFFFF",
};
const W = 1600,
  H = 900,
  N = 14;
const esc = (x) =>
  String(x)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const money = (x, n = 4) => "$" + x.toFixed(n);
const report = "../llm-file-editing-poc-2026-10-12.md";
const source =
  "../../../experiments/llm-export/results/2026-10-12/summary.json";
const slides = [];
let nodes = [];
function rect(x, y, w, h, fill = C.soft, r = 0, stroke = "none") {
  nodes.push(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`,
  );
}
function text(
  x,
  y,
  s,
  size = 28,
  color = C.ink,
  weight = 400,
  max = 1472,
  anchor = "start",
) {
  nodes.push(
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" data-max-width="${max}">${esc(s)}</text>`,
  );
}
function lines(
  x,
  y,
  arr,
  size = 28,
  color = C.ink,
  weight = 400,
  gap = 42,
  max = 1472,
) {
  arr.forEach((s, i) => text(x, y + i * gap, s, size, color, weight, max));
}
function line(x1, y1, x2, y2, color = C.line, width = 2, dash = "") {
  nodes.push(
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
  );
}
function arrow(x1, y1, x2, y2, color = C.blue, width = 3) {
  line(x1, y1, x2, y2, color, width);
  const a = Math.atan2(y2 - y1, x2 - x1),
    len = 12,
    spread = 0.52;
  const a1 = [x2 - len * Math.cos(a - spread), y2 - len * Math.sin(a - spread)],
    a2 = [x2 - len * Math.cos(a + spread), y2 - len * Math.sin(a + spread)];
  nodes.push(
    `<path d="M${a1[0]} ${a1[1]} L${x2} ${y2} L${a2[0]} ${a2[1]}" fill="none" stroke="${color}" stroke-width="${width}"/>`,
  );
}
function circle(x, y, r, fill = C.blue) {
  nodes.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`);
}
function number(x, y, n, color = C.blue) {
  circle(x, y - 9, 21, color);
  text(x, y, n, 22, C.white, 600, 40, "middle");
}
function note(s, color = C.muted) {
  text(64, 780, s, 23, color, 400, 1472);
}
function panel(x, y, w, h, title, body, fill = C.blueBg, color = C.blue) {
  rect(x, y, w, h, fill, 8);
  text(x + 24, y + 45, title, 30, color, 600, w - 48);
  lines(x + 24, y + 95, body, 25, C.ink, 400, 39, w - 48);
}
function begin(title, subtitle, section = "仕組みと結果") {
  nodes = [];
  rect(0, 0, W, H, C.white);
  text(64, 51, `LLMによる会計帳票編集  /  ${section}`, 20, C.blue, 600);
  text(64, 122, title, 48, C.ink, 600);
  if (subtitle) text(64, 169, subtitle, 26, C.muted);
  line(64, 194, 1536, 194);
}
function finish(
  file,
  title,
  notes,
  sources = [
    { label: "検証結果", href: report },
    { label: "集計JSON", href: source },
  ],
) {
  const i = slides.length + 1;
  line(64, 822, 1536, 822);
  text(64, 858, "2026-10-12  /  会計帳票の直接編集 PoC", 18, C.muted);
  text(
    1536,
    858,
    `${String(i).padStart(2, "0")} / ${N}`,
    21,
    C.muted,
    600,
    90,
    "end",
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(notes)}</desc><metadata>${esc(JSON.stringify({ date: "2026-10-12", sources }))}</metadata><style>text{font-family:'Hiragino Sans','Noto Sans CJK JP','Yu Gothic',sans-serif}</style>\n${nodes.join("\n")}\n</svg>\n`;
  fs.writeFileSync(path.join(here, file + ".svg"), svg);
  slides.push({ file, title, notes, sources, svg });
}

// 01
begin(
  "AIに帳票の解釈と編集を任せる",
  "実装した反復処理と、3モデルを使った検証結果",
  "実験の概要",
);
text(64, 318, "書式を読む。コードを実行する。", 52, C.ink, 600);
text(64, 394, "結果を見て、編集を進める。", 52, C.ink, 600);
text(
  64,
  463,
  "大学別のセル対応表を渡さず、既存のExcelを記入した。",
  29,
  C.muted,
);
line(64, 510, 1536, 510);
text(64, 555, "Solの完了・静的合格", 25, C.green, 600, 600);
text(64, 670, "12 / 12", 92, C.green, 600, 600);
text(720, 555, "実験全体の費用推計", 25, C.blue, 600, 750);
text(720, 670, money(summary.costAndUsage.estimatedUsd), 92, C.blue, 600, 750);
note(
  "同じ4つの基本ケースを反復。費用はusageによる推計で、確定請求額との照合は未実施。",
);
finish(
  "01-overview",
  "AIに帳票の解釈と編集を任せる",
  "今回のPoCは、AI自身がExcelを調べ、コード実行を繰り返して成果物を生成する方式の検証。Solは固定条件の12試行すべてで静的合格かつ応答完了。未見データ・本番の自動提出の信頼性を保証する結果ではない。",
);

// 02
begin(
  "方針転換で変えたこと",
  "帳票ごとの判断と編集コードを、実行時のAIに任せる",
  "方針",
);
text(64, 260, "これまでの想定", 28, C.muted, 600);
panel(64, 292, 350, 154, "会計データ", ["規定のデータを用意"], C.soft, C.muted);
arrow(430, 369, 478, 369, C.muted);
panel(
  496,
  292,
  610,
  154,
  "大学別の変換・配置ロジック",
  ["開発者が分類・集計・セル対応を実装"],
  C.soft,
  C.muted,
);
arrow(1122, 369, 1170, 369, C.muted);
panel(
  1186,
  292,
  350,
  154,
  "出力ファイル",
  ["実装した規則で生成"],
  C.soft,
  C.muted,
);
text(64, 508, "今回のPoC", 28, C.blue, 600);
panel(64, 542, 350, 164, "Excelと取引JSON", ["書式と事実を渡す"]);
arrow(430, 624, 478, 624);
panel(496, 542, 610, 164, "AIが調べて、その場で編集", [
  "意味・記入位置・手法を判断し、コードを実行",
]);
arrow(1122, 624, 1170, 624);
panel(
  1186,
  542,
  350,
  164,
  "編集済みExcel",
  ["別の評価器で検査"],
  C.greenBg,
  C.green,
);
note(
  "正しさの基準は評価側に残す。モデルには採点用の正解やセル対応を渡していない。",
);
finish(
  "02-approach",
  "方針転換で変えたこと",
  "従来の大学別Data Frameやセル配置の事前実装を止め、LLMによる実行時の調査・編集を検証した。入力と正しさの基準まで捨てたわけではなく、独立した評価側に保持する。",
);

// 03
begin(
  "実装の全体構成",
  "ローカルの計測と、AIが編集する隔離環境を分ける",
  "実装",
);
rect(64, 238, 682, 470, C.soft, 8);
rect(790, 238, 746, 470, C.blueBg, 8);
text(88, 281, "このプロジェクト内", 25, C.muted, 600, 640);
text(814, 281, "OpenAI側", 25, C.blue, 600, 696);
panel(
  88,
  314,
  285,
  164,
  "実行ランナー",
  ["Excel・JSON・指示", "モデルと条件を指定"],
  C.white,
  C.ink,
);
panel(
  425,
  314,
  297,
  164,
  "ゲートウェイ",
  ["予算予約・API呼出し", "usage・費用を記録"],
  C.white,
  C.ink,
);
arrow(382, 398, 415, 398);
arrow(732, 398, 810, 398);
panel(
  822,
  314,
  682,
  164,
  "Responses API の1応答",
  ["AIがツール結果を読み、次の処理を選ぶ"],
  C.white,
  C.blue,
);
text(89, 535, "APIキーはAIに渡さず、ローカルで管理", 25, C.ink, 600, 626);
text(89, 578, "SQLite台帳とJSONログに実行記録を保存", 25, C.muted, 400, 626);
text(845, 542, "AI", 32, C.blue, 600, 130);
arrow(930, 531, 1035, 531);
arrow(1035, 565, 930, 565);
text(1060, 550, "Code Interpreter", 31, C.blue, 600, 410);
text(822, 624, "専用1GBコンテナでPythonなどを実行", 25, C.ink, 400, 682);
text(
  822,
  666,
  "アップロードしたコピーを編集・ネットワーク無効",
  24,
  C.muted,
  400,
  682,
);
rect(88, 627, 634, 56, C.greenBg, 4);
text(112, 664, "成果物を取得し、独立した評価器で検査", 26, C.green, 600, 586);
line(1504, 446, 1518, 446, C.green, 3);
line(1518, 446, 1518, 730, C.green, 3);
line(1518, 730, 410, 730, C.green, 3);
arrow(410, 730, 410, 691, C.green);
text(1000, 758, "output.xlsx を取得", 20, C.green, 600, 450);
note(
  "アプリ本体のDB・出力画面への組み込みは未実装。今回は独立した検証用ランナー。",
);
finish(
  "03-architecture",
  "実装の全体構成",
  "run.tsが入力準備、Gateway起動、アップロード、Responses呼出し、成果物取得、静的評価、後片付けを担当。gateway/server.tsとledger.tsが認証・予算・単価・usage・履歴を記録する。Code InterpreterはAPIキーやリポジトリを受け取らない。",
  [
    { label: "ランナー", href: "../../../experiments/llm-export/run.ts" },
    {
      label: "ゲートウェイ",
      href: "../../../experiments/llm-export/gateway/server.ts",
    },
    {
      label: "ゲートウェイ設計",
      href: "../../design/llm-evaluation-gateway.md",
    },
  ],
);

// 04
begin(
  "AIとツールのやり取り",
  "1試行につき1回のResponses API呼出し。その内部で実行と確認を繰り返す",
  "反復処理",
);
text(222, 260, "AIの判断", 31, C.blue, 600, 410);
text(962, 260, "Code Interpreter", 31, C.green, 600, 500);
line(402, 287, 402, 705, C.line, 3);
line(1130, 287, 1130, 705, C.line, 3);
const seq = [
  [328, "書式と入力を調べるコード", true],
  [400, "セル・数式・結合範囲などの実行結果", false],
  [472, "結果を踏まえて編集するコード", true],
  [544, "保存した値・警告・エラー", false],
  [616, "必要に応じて修正し、再読込するコード", true],
  [688, "確認結果と完成ファイル", false],
];
seq.forEach(([y, label, out]) => {
  circle(out ? 402 : 1130, y, 7, out ? C.blue : C.green);
  arrow(out ? 418 : 1114, y, out ? 1114 : 418, y, out ? C.blue : C.green);
  rect(530, y - 32, 496, 27, C.white);
  text(778, y - 12, label, 23, C.ink, 400, 655, "middle");
});
text(
  64,
  746,
  "実行結果を次の判断に使うことが、今回のinteractiveな編集",
  30,
  C.blue,
  600,
  1472,
);
note(
  "独立評価器の結果をAIへ自動で戻すループや、利用者向けの会話画面はまだない。",
);
finish(
  "04-tool-loop",
  "AIとツールのやり取り",
  "図は概念的な反復。ツールの実行順や回数はモデルが決める。今回ローカル側で複数のResponsesをつないだ対話ループは実装していない。1つのResponsesの内部でCode Interpreter呼出しが反復される。ローカル評価器はファイル取得後に動作する。",
  [
    { label: "ランナー", href: "../../../experiments/llm-export/run.ts" },
    { label: "共通の指示", href: "../../../experiments/llm-export/prompt.md" },
  ],
);

// 05
begin(
  "実際の反復例：Sol × 学習院",
  "1回のAPI応答の中でCode Interpreterを11回実行。所要時間104.344秒",
  "実行ログの例",
);
const steps = [
  ["調べる", "全シート、数式、結合セル、図形、印刷設定を読む"],
  ["編集する", "必要なXMLを部分編集し、小計の数式を6つ追加する"],
  ["結果を確かめる", "使い捨てコピーを再計算するが、保存済みの計算値が0のまま"],
  ["方法を修正する", "計算値を消して再計算を促し、ZIPを書き込む処理も修正する"],
  ["保存物を読み直す", "計算結果を元の構造へ戻し、値・式・ZIP差分を確認する"],
  ["成果物を返す", "Excelへのリンクと、変更点・使った環境・未確認事項を返す"],
];
steps.forEach(([label, body], i) => {
  let y = 250 + i * 75;
  number(88, y + 12, i + 1, i < 4 ? C.blue : C.green);
  text(136, y + 12, label, 28, C.ink, 600, 290);
  text(444, y + 12, body, 26, C.ink, 400, 1092);
  if (i < 5) line(136, y + 43, 1536, y + 43);
});
rect(64, 716, 1472, 72, C.greenBg, 6);
text(
  89,
  762,
  "収入の部計 ¥30,000　実支出 ¥5,000　次年度繰越 ¥25,000　／　独立した静的検査に合格",
  29,
  C.green,
  600,
  1420,
);
finish(
  "05-real-trace",
  "実際の反復例：Sol × 学習院",
  "Solの学習院初回実行ログから要約。Code Interpreter 11回は、API応答11回やコンテナ11個を意味しない。モデルはLibreOfficeで使い捨てコピーを処理し、確認した計算値を元の構造を保持したXLSXへ戻した。収入の部計30,000円は期首繰越10,000円と当年度収入20,000円の合計。編集した主なパーツは対象シートと計算チェーン。後から実際のExcelでも入力変更・再計算と1ページの印刷を確認した。",
  [
    {
      label: "初回の生成Excel",
      href: "../../../experiments/llm-export/results/2026-10-12/examples/gakushuin-sol-r1.xlsx",
    },
    { label: "検証結果", href: report },
  ],
);

// 06
begin(
  "API費用をゲートウェイで計測",
  "再起動しても同じSQLite台帳と、実験全体の$10予算を引き継ぐ",
  "費用計測",
);
const gx = [64, 446, 828, 1210];
[
  ["送信前", "保守的な金額を予約"],
  ["呼出し", "要求・応答を記録"],
  ["応答後", "usageから推計を精算"],
  ["終了時", "ファイルと環境を削除"],
].forEach(([t, b], i) => {
  panel(
    gx[i],
    260,
    326,
    175,
    t,
    [b],
    i === 3 ? C.greenBg : C.blueBg,
    i === 3 ? C.green : C.blue,
  );
  if (i < 3) arrow(gx[i] + 337, 348, gx[i] + 368, 348);
});
text(64, 511, "記録するもの", 29, C.ink, 600);
lines(
  64,
  559,
  [
    "モデル・設定・入力と指示のハッシュ",
    "入力／出力／キャッシュのトークン数",
    "提供元の識別子・失敗・後片付けの結果",
  ],
  26,
  C.ink,
  400,
  47,
  690,
);
line(776, 490, 776, 718);
text(828, 511, "過小計上を防ぐルール", 29, C.ink, 600, 700);
lines(
  828,
  559,
  [
    "費用が分からなければ、予約を残す",
    "自動リトライで同じ試行を重ねない",
    "内部ツール回数でコンテナ費用を増やさない",
  ],
  26,
  C.ink,
  400,
  47,
  708,
);
note(
  "usageと固定単価による推計。提供元の確定請求額との照合は別途行う。",
  C.blue,
);
finish(
  "06-cost-gateway",
  "API費用をゲートウェイで計測",
  "Gatewayはloopback限定のHTTP入口と実行用トークンを使い、固定のOpenAI API endpointへ送る。予算予約は送信前にSQLiteへ永続化。未知の費用は0として処理せず予約を保持する。1GBコンテナは専用セッション1個あたり$0.03を保守的に推計する。",
  [
    {
      label: "ゲートウェイ設計",
      href: "../../design/llm-evaluation-gateway.md",
    },
    {
      label: "台帳実装",
      href: "../../../experiments/llm-export/gateway/ledger.ts",
    },
  ],
);

// 07
begin(
  "比較した条件",
  "モデル以外の条件を揃え、同じ基本ケースを3回ずつ実行した",
  "実験設計",
);
text(64, 323, "4書式", 70, C.blue, 600, 360);
text(425, 323, "×", 58, C.muted, 400, 70);
text(530, 323, "3モデル", 70, C.blue, 600, 390);
text(941, 323, "×", 58, C.muted, 400, 70);
text(1045, 323, "3回", 70, C.blue, 600, 245);
text(1310, 323, "= 36", 70, C.green, 600, 226);
text(64, 381, "立命館・学習院・法政・早稲田", 26, C.muted, 400, 680);
text(64, 476, "モデル", 28, C.ink, 600);
lines(
  64,
  526,
  ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"],
  31,
  C.ink,
  500,
  48,
  590,
);
text(760, 476, "共通条件", 28, C.ink, 600);
lines(
  760,
  526,
  [
    "出力上限8,000トークン・reasoning medium",
    "1試行1応答・新しい専用1GBコンテナ",
    "直列実行・自動リトライなし",
  ],
  27,
  C.ink,
  400,
  48,
  776,
);
rect(64, 701, 1472, 80, C.soft, 6);
text(
  88,
  749,
  "別枠：保存対照4応答 ＋ 追加条件4応答 ＋ 接続確認3応答　　合計47応答",
  28,
  C.ink,
  600,
  1424,
);
finish(
  "07-experiment",
  "比較した条件",
  "4つとも匿名化した研究用参照コピーと合成取引の基本ケース。正式提出書式や未見データの網羅的な評価ではない。早稲田は会計報告シートのみを編集対象とし他4シートは保持。法政にもともとある参照切れ数式6セルは修正対象外。思考トークンも8,000の出力上限に含む。",
);

// 08
begin(
  "合格と完了を分けて確認",
  "ファイル内の値だけで、成功とは判定しない",
  "評価",
);
rect(64, 245, 676, 383, C.blueBg, 8);
text(90, 296, "静的合格", 36, C.blue, 600, 624);
text(90, 354, "内容", 28, C.ink, 600, 600);
text(90, 397, "金額・分類・識別番号・明細など", 27, C.ink, 400, 624);
line(90, 427, 714, 427);
text(90, 475, "構造と保持", 28, C.ink, 600, 600);
lines(
  90,
  519,
  ["数式・対象外シート・図形・コメント", "入力規則・印刷設定・XMLの整合性"],
  26,
  C.ink,
  400,
  43,
  624,
);
rect(788, 245, 748, 383, C.greenBg, 8);
text(814, 296, "完了した成果物", 36, C.green, 600, 696);
[
  "提供元の応答が completed",
  "空でない最終回答も完了",
  "Excelを取得できる",
  "独立した静的検査に合格",
].forEach((s, i) => {
  number(838, 359 + i * 67, i + 1, C.green);
  text(879, 359 + i * 67, s, 28, C.ink, 400, 631);
});
text(
  64,
  689,
  "Excelで開く・再計算する・印刷する確認は、さらに別の検証",
  30,
  C.ink,
  600,
  1472,
);
lines(
  64,
  744,
  [
    "評価器は出力を見た後に訂正した。元の評価を残し、全取得済み成果物へ同じ基準を適用。",
    "事前に完全固定したベンチマークではない点も、結果の限界として記録した。",
  ],
  23,
  C.muted,
  400,
  35,
  1472,
);
finish(
  "08-evaluation",
  "合格と完了を分けて確認",
  "静的な合格は、Excel互換性・表示・提出品質の完全な保証ではない。応答完了判定は最終説明の全要件を自動採点したものでもない。3つの狭い期待値条件を修正し、結合セル内の非表示入力や名前空間の不備などの見落としも修正した。すべての元成果物と訂正履歴を保持した。",
);

// 09
begin(
  "Solが12回すべてで合格・完了",
  "固定条件の36試行。追加条件の4試行は、この表へ含めない",
  "比較結果",
);
const tx = [88, 485, 730, 999, 1250];
rect(64, 252, 1472, 75, C.ink);
["モデル", "静的合格", "合格・完了", "平均費用／試行", "時間中央値"].forEach(
  (s, i) => text(tx[i], 300, s, 25, C.white, 600, [370, 220, 244, 226, 262][i]),
);
const models = ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"];
models.forEach((m, i) => {
  const d = summary.metricsByModel[m];
  const y = 327 + i * 112;
  rect(64, y, 1472, 112, i === 0 ? C.greenBg : i === 1 ? C.white : C.soft);
  line(64, y + 112, 1536, y + 112);
  text(tx[0], y + 67, m, 31, C.ink, 600, 370);
  text(
    tx[1],
    y + 67,
    `${d.staticPasses} / 12`,
    33,
    i === 0 ? C.green : C.ink,
    600,
    220,
  );
  text(
    tx[2],
    y + 67,
    `${d.completedWorkbooks} / 12`,
    38,
    i === 0 ? C.green : C.red,
    600,
    244,
  );
  text(
    tx[3],
    y + 67,
    money(d.estimatedComparisonTotalUsd / 12),
    31,
    C.ink,
    500,
    226,
  );
  text(
    tx[4],
    y + 67,
    d.comparisonLatencySeconds.median.toFixed(1) + "秒",
    31,
    C.ink,
    500,
    262,
  );
});
text(
  64,
  727,
  "失敗分を含む「合格・完了1件」の費用：Sol $0.1354 ／ 5.6 Luna $0.4973",
  29,
  C.blue,
  600,
  1472,
);
note(
  "6 Lunaは合格・完了0件のため単価を算出できない。時間は失敗も含み、後片付けを除く。",
);
finish(
  "09-results",
  "Solが12回すべてで合格・完了",
  "各モデル12試行。Solは12ファイル、6 Lunaは2ファイル、5.6 Lunaは12ファイルを取得。6 Lunaの立命館の静的合格は応答途中終了だった。5.6 Lunaは内容だけなら7/12が合格している。比較費用のみを用い、保存対照や追加試行等の費用はこのモデル表へ混ぜない。",
);

// 10
begin(
  "金額が合っていても、帳票は壊れる",
  "保存手法の選択と、見える位置・構造の確認が必要だった",
  "失敗の分析",
);
text(64, 268, "01  保存しただけで図形が消える", 30, C.ink, 600, 1472);
text(
  64,
  318,
  "openpyxl対照：4書式で機能・表現の欠落。法政では説明用図形22個が消失。",
  27,
  C.muted,
);
line(64, 350, 1536, 350);
text(
  64,
  407,
  "02  正しい文字列が、表示されない位置に入る",
  30,
  C.ink,
  600,
  1472,
);
rect(64, 443, 606, 89, C.soft, 2, C.line);
line(382, 443, 382, 532, C.line, 2, "8 6");
text(86, 474, "C28：結合範囲の左上", 19, C.muted, 400, 284);
text(405, 474, "D28：結合の内部", 19, C.red, 400, 244);
text(86, 512, "団体コードNO.", 26, C.ink, 600, 280);
text(405, 512, "007", 28, C.red, 600, 244);
lines(
  730,
  476,
  [
    "6 Lunaの学習院では、正しいコードをD28へ記入。",
    "結合されたC28:D28では、その値が表示されない。",
  ],
  26,
  C.ink,
  400,
  41,
  806,
);
text(
  64,
  567,
  "模式図。破線は説明用で、Excelで見えるセル境界ではない。",
  21,
  C.muted,
  400,
  1472,
);
line(64, 596, 1536, 596);
text(64, 655, "03  XML編集でセルを削除・移動してしまう", 30, C.ink, 600, 1472);
text(
  64,
  705,
  "5.6 Lunaの早稲田では、実際のExcelがファイルの修復を要求した。",
  27,
  C.muted,
);
note(
  "図形・コメント・入力規則の保持と、OOXMLの整合性を、金額の検査と分けて確認する。",
);
finish(
  "10-failures",
  "金額が合っていても、帳票は壊れる",
  "保存対照では4書式すべてでセル値と等価な数式は保持したが、一部の機能・表現が失われた。6 Lunaの学習院3回目ではC28:D28およびF28:G28の非左上セルへ入力していた。5.6 Lunaの早稲田初回では47セルが削除され、別の47セルが不適切な親行の配下にあった。全ての静的差分を、観察済みの見た目の破損とは扱っていない。",
);

// 11
begin(
  "追加条件でも、課題が残った",
  "失敗ケースに対する新規試行を4回。前回の成果物や履歴は渡していない",
  "追加調査",
);
rect(64, 247, 1472, 65, C.ink);
text(88, 290, "変更した条件", 25, C.white, 600, 420);
text(527, 290, "対象", 25, C.white, 600, 175);
text(735, 290, "観察した結果", 25, C.white, 600, 775);
const extra = [
  [
    "6 Luna：上限12,000",
    "学習院",
    ["上限到達。ダウンロード可能な成果物なし。"],
  ],
  [
    "6 Luna：上限12,000",
    "早稲田",
    ["成果物は静的合格。最終回答は上限で途中終了。"],
  ],
  [
    "5.6 Luna：保持指示",
    "法政",
    ["金額・数式・22図形は保持。", "接頭辞の宣言が欠け、構造検査で不合格。"],
  ],
  [
    "5.6 Luna：保持指示",
    "早稲田",
    ["式・パーツは保持。", "意味が未確定の日付欄を埋めてしまい不合格。"],
  ],
];
extra.forEach(([a, b, ls], i) => {
  const y = 312 + i * 97;
  rect(64, y, 1472, 97, i % 2 ? C.soft : C.white);
  line(64, y + 97, 1536, y + 97);
  text(88, y + 55, a, 27, C.ink, 500, 420);
  text(527, y + 55, b, 27, C.ink, 500, 175);
  lines(735, y + (ls.length === 1 ? 55 : 38), ls, 25, C.ink, 400, 36, 775);
});
text(
  64,
  751,
  "4回とも「合格・完了」の全条件には到達しなかった",
  32,
  C.amber,
  600,
  1472,
);
note(
  "各条件・各書式1回だけの観察。主比較の成功率へ混ぜず、改善率の推定にも使わない。",
);
finish(
  "11-followups",
  "追加条件でも、課題が残った",
  "出力上限を増やす条件と、大学・セル・正解を含まない一般的なXML保持指示を加える条件を分けた。法政の追加試行ではmc:Ignorableが未宣言の名前空間接頭辞を参照していた。OOXML適合性の不備だが、この成果物の実Excel修復は観察していない。早稲田はH2の意味が未確定なのに、別の報告日を複写した。",
);

// 12
begin(
  "実験全体の費用は、推計$2.9245",
  "47回のResponsesを同じ台帳で計測。予算$10内で終了した",
  "費用結果",
);
text(64, 357, money(summary.costAndUsage.estimatedUsd), 100, C.blue, 600, 680);
text(68, 410, "使用量に基づく推計額", 28, C.muted, 400, 680);
const total = summary.costAndUsage.estimatedUsd,
  token = summary.costAndUsage.tokenUsd;
const bx = 64,
  by = 474,
  bw = 688;
rect(bx, by, (bw * token) / total, 64, C.blue);
rect(
  bx + (bw * token) / total,
  by,
  (bw * (total - token)) / total,
  64,
  C.green,
);
text(64, 587, "トークン", 26, C.blue, 600, 285);
text(64, 628, money(token), 38, C.blue, 600, 315);
text(424, 587, "コンテナ44個", 26, C.green, 600, 328);
text(424, 628, "$1.3200", 38, C.green, 600, 328);
text(64, 710, "未使用の予算 $7.0755", 29, C.muted, 500, 688);
const cx = 828;
text(cx, 279, "内訳", 28, C.ink, 600, 700);
[
  ["基本比較 36応答", "$2.5702"],
  ["保存対照 4応答", "$0.1847"],
  ["追加条件 4応答", "$0.1695"],
  ["接続確認 3応答", "$0.0001"],
].forEach(([a, b], i) => {
  let y = 338 + i * 78;
  text(cx, y, a, 28, C.ink, 400, 470);
  text(1536, y, b, 31, C.ink, 500, 230, "end");
  line(cx, y + 26, 1536, y + 26);
});
text(cx, 686, "未解決費用・残予約 0", 29, C.green, 600, 708);
note(
  "確定請求額との照合は未実施。税・為替・人の調査や確認作業・本番運用費は含まない。",
);
finish(
  "12-cost-results",
  "実験全体の費用は、推計$2.9245",
  "正確な合計は$2.924513275。トークン$1.604513275と44コンテナ$1.32。コンテナは1GBの20分セッション相当$0.03を保守的に加算しており、提供元の確定請求額ではない。独立した再計算は台帳と完全一致。44コンテナとアップロード84ファイルを削除した。表の金額は丸めて表示。",
);

// 13
begin(
  "生成したExcelを、実際のExcelでも確認",
  "学習院・Sol初回の印刷証拠。モデルの元成果物を変更せず、コピーで検査した",
  "成果物",
);
const pic = fs
  .readFileSync(path.join(here, "assets/gakushuin-excel-print.png"))
  .toString("base64");
rect(64, 222, 782, 560, C.soft, 0, C.line);
nodes.push(
  `<image x="70" y="228" width="770" height="548" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${pic}"/>`,
);
text(894, 282, "学習院・初回の出力", 32, C.ink, 600, 642);
lines(
  894,
  343,
  [
    "部費の入力を ¥10,000 から",
    "¥10,050 に変更すると、",
    "総計も ¥30,050 に更新。",
  ],
  30,
  C.ink,
  400,
  48,
  642,
);
text(894, 539, "修復ダイアログなし", 29, C.green, 600, 642);
text(894, 588, "A4横1ページのPDFを確認", 29, C.green, 600, 642);
lines(
  894,
  669,
  [
    "Sol初回の4書式で再計算を確認。",
    "全体の表示・PDF確認は2書式。",
    "全試行の提出品質を保証するものではない。",
  ],
  23,
  C.muted,
  400,
  38,
  642,
);
finish(
  "13-artifact-proof",
  "生成したExcelを、実際のExcelでも確認",
  "左は実際のExcelから保存したPDFの1ページを画像化したもの。使い捨てコピーの入力変更を元へ戻して印刷した。Sol初回4書式で入力変更と再計算を確認、PDFの全体確認は立命館と学習院のみ。モデルによるCode Interpreter内の確認とは独立した証拠。",
  [
    {
      label: "Excelで保存したPDF",
      href: "../../../experiments/llm-export/results/2026-10-12/examples/gakushuin-sol-r1.pdf",
    },
    {
      label: "モデルの生成Excel",
      href: "../../../experiments/llm-export/results/2026-10-12/examples/gakushuin-sol-r1.xlsx",
    },
    { label: "検証結果", href: report },
  ],
);

// 14
begin(
  "次の候補は、Solによる下書き生成",
  "今回の4基本ケースでは、AI自身に帳票の解釈と編集を任せられた",
  "判断と次の段階",
);
rect(64, 240, 1472, 105, C.greenBg, 6);
text(
  89,
  305,
  "人が差分と未確認事項を確認する運用を、次の検証対象にする",
  37,
  C.green,
  600,
  1422,
);
const next = [
  ["評価を固定して広げる", "未見の取引、不足情報、長文、明細枠超過を追加する"],
  [
    "共通の編集操作を検証する",
    "結合セル・名前空間・ZIPパーツを安全に扱う手段を比べる",
  ],
  [
    "人との対話を実装する",
    "質問、変更案の確認、追加指示による再編集を設計する",
  ],
];
next.forEach(([a, b], i) => {
  const y = 411 + i * 104;
  number(88, y, i + 1, C.blue);
  text(135, y, a, 30, C.ink, 600, 480);
  text(665, y, b, 27, C.ink, 400, 871);
  if (i < 2) line(135, y + 45, 1536, y + 45);
});
lines(
  64,
  751,
  [
    "今回まだ作っていないもの：利用者向け会話画面、DB連携、アプリの出力API、自動提出。",
  ],
  24,
  C.muted,
  400,
  35,
  1472,
);
finish(
  "14-next-steps",
  "次の候補は、Solによる下書き生成",
  "同じ4つの小さな合成ケースの反復であり、汎用的な成功率や未見データの信頼性は推定できない。次の検証では評価器を事前固定し、ケースとExcel確認の範囲を広げる。共通ツールに大学別の判断や正解を埋め込まない。人とのチャットによる編集画面は今回の実装範囲に含まれていない。",
);

if (slides.length !== N) throw new Error("Slide count mismatch");
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLMによる会計帳票編集 — 仕組みと検証結果</title><style>
*{box-sizing:border-box}html{color-scheme:light}body{margin:0;background:#e8edf3;color:${C.ink};font-family:'Hiragino Sans','Noto Sans CJK JP',sans-serif}.toolbar{min-height:60px;display:flex;align-items:center;gap:12px;padding:10px 24px;background:#fff;border-bottom:1px solid ${C.line};position:sticky;top:0;z-index:2}button,select{font:inherit;font-size:14px;color:${C.ink};padding:8px 12px;background:#fff;border:1px solid ${C.line};border-radius:6px;cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid ${C.blue}}.toolbar .name{font-size:14px;font-weight:600;margin-right:auto}#stage{padding:24px}.slide{display:none;max-width:1600px;margin:auto}.slide.active{display:block}.canvas{background:white;box-shadow:0 6px 25px #192c401a}.canvas svg{display:block;width:100%;height:auto}details{background:#fff;padding:18px 24px;margin-top:14px;border-radius:6px;font-size:16px;line-height:1.8}summary{cursor:pointer;font-weight:600}details p{max-width:1050px}.sources a{color:${C.blue};margin-right:22px}.help{max-width:1600px;margin:15px auto 0;color:${C.muted};font-size:13px}.overview .slide{display:block;margin-bottom:32px}.overview details{display:none}.overview #stage{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.overview .help{display:none}@media(max-width:800px){.toolbar{flex-wrap:wrap;padding:10px}.toolbar .name{width:100%}#stage{padding:10px}.overview #stage{grid-template-columns:1fr}details{font-size:14px}.help{font-size:12px}select{max-width:60vw}}@media print{@page{size:1600px 900px;margin:0}body{background:#fff}.toolbar,details,.help{display:none!important}#stage,.overview #stage{display:block;padding:0}.slide,.slide.active,.overview .slide{display:block;width:1600px;height:900px;max-width:none;margin:0;break-after:page;page-break-after:always}.slide:last-of-type{break-after:auto;page-break-after:auto}.canvas{box-shadow:none}}
</style><header class="toolbar"><span class="name">会計帳票の直接編集 PoC</span><button id="prev" aria-label="前のスライド">前へ</button><select id="select" aria-label="スライドを選ぶ">${slides.map((s, i) => `<option value="${i}">${String(i + 1).padStart(2, "0")}　${esc(s.title)}</option>`).join("")}</select><button id="next" aria-label="次のスライド">次へ</button><button id="overview" aria-pressed="false">一覧</button><button id="full">全画面</button></header><main id="stage">${slides
  .map(
    (s, i) =>
      `<section class="slide${i === 0 ? " active" : ""}" id="slide-${i + 1}" aria-label="${i + 1}. ${esc(s.title)}"><div class="canvas">${s.svg
        .replace(/id="title"/g, `id="title-${i}"`)
        .replace(/id="desc"/g, `id="desc-${i}"`)
        .replace(
          'aria-labelledby="title desc"',
          `aria-labelledby="title-${i} desc-${i}"`,
        )}</div><details><summary>補足と出典</summary><p>${esc(s.notes)}</p><div class="sources">${s.sources.map((x) => `<a href="${esc(x.href)}">${esc(x.label)}</a>`).join("")}</div></details></section>`,
  )
  .join(
    "",
  )}</main><p class="help">← → または Space で移動。Home / End で先頭・末尾。O で一覧。印刷時は全14枚を出力します。資料の参照リンクはリポジトリ内で開く場合に利用できます。</p><script>
const pages=[...document.querySelectorAll('.slide')], sel=document.querySelector('#select');let current=0;
function show(i,update=true){current=Math.max(0,Math.min(pages.length-1,i));pages.forEach((p,n)=>p.classList.toggle('active',n===current));sel.value=String(current);document.querySelector('#prev').disabled=current===0;document.querySelector('#next').disabled=current===pages.length-1;if(update)history.replaceState(null,'','#'+(current+1));}
function toggleOverview(){const on=document.body.classList.toggle('overview');document.querySelector('#overview').setAttribute('aria-pressed',String(on));}
document.querySelector('#prev').onclick=()=>show(current-1);document.querySelector('#next').onclick=()=>show(current+1);sel.onchange=()=>show(Number(sel.value));document.querySelector('#overview').onclick=toggleOverview;document.querySelector('#full').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{document.querySelector('#full').textContent='全画面は未対応'}};
document.addEventListener('keydown',e=>{if(e.target.closest('button,select,summary,a,input,textarea'))return;if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();show(current+1)}else if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();show(current-1)}else if(e.key==='Home')show(0);else if(e.key==='End')show(pages.length-1);else if(e.key.toLowerCase()==='o')toggleOverview()});const start=Number(location.hash.slice(1));show(Number.isInteger(start)&&start>=1?start-1:0,false);
</script></html>`;
fs.writeFileSync(path.join(here, "index.html"), html);
fs.writeFileSync(
  path.join(here, "slides.json"),
  JSON.stringify(
    slides.map(({ svg, ...rest }) => rest),
    null,
    2,
  ) + "\n",
);
const md = `# LLMによる会計帳票編集の説明スライド\n\n[スライドを開く](index.html) / [PDF](llm-file-editing-slides.pdf) / [配布用ZIPの作成](#配布用zip) / [詳細な検証結果](${report})\n\n以前の会計データ管理のSVG資料の配色・字体を引き継いだ、日本語14枚のスライド。仕組み、実際のツール反復、比較結果、費用、限界を説明する。SVGは1600 × 900。PNGは3200 × 1800ピクセルで、スライドソフトや文書へ貼り付けられる。\n\nindex.htmlは図を埋め込んだ単独ファイルで、外部サービスへの通信なしで表示できる。左右キー・Space・ページ選択で移動し、一覧表示と補足・出典も利用できる。ブラウザーの印刷では全ページを出力する。参照資料へのリンクは元のリポジトリ内の位置を前提とする。\n\n「interactive」はAIとコード実行環境の反復を指す。利用者向けの会話編集画面は今回未実装。実験費用$2.924513275はusageによる推計であり、確定請求額ではない。\n\n${slides.map((s, i) => `## ${i + 1}. ${s.title}\n\n[SVG](${s.file}.svg) / [PNG](${s.file}.png)\n\n![${s.title}](${s.file}.png)`).join("\n\n")}\n\n## 配布用ZIP\n\n\`python3 docs/reports/llm-file-editing-slides/package.py\` でSVG・PNG・PDF・HTML一式の llm-file-editing-slides.zip を生成する。ZIPは配布用の重複データなのでgit管理外。元の資料はこのフォルダーに保存している。\n\n## 編集と再生成\n\n\`node docs/reports/llm-file-editing-slides/build.mjs\` でSVG、HTML、目次、スライド補足を再生成する。実測値は保存済みsummary.jsonを読み取り、APIは呼ばない。\n\nPNGとPDFはmacOSのAppKitでオフライン生成した。同梱の render-png.swift に入力SVG・出力PNG・倍率2を渡すとPNGを、render-pdf.swift に出力PDF・14枚の入力SVGを順に渡すとPDFを再生成できる。フォントはHiragino Sansを使用。生成後は文字のはみ出し・画像・全ページの表示を確認する。\n\n成果物の図版は実際のExcel印刷PDFから作った画像。SVG内へ埋め込んであり、外部フォント・画像・JavaScriptライブラリは取得しない。\n`;
fs.writeFileSync(path.join(here, "README.md"), md);
console.log(
  JSON.stringify({
    slides: slides.length,
    directory: path.relative(root, here),
    size: [W, H],
  }),
);
