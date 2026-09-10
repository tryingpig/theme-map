/* 메인 화면 — 코스피·코스닥 대비 테마 수익률.
   data/index.json(요약) + data/series.json(일별 시계열)만 읽는다.
   테마가 늘어도 이 파일은 그대로다. */

/* 계열 색은 **테마마다 고정**이다. 자리는 build.py가 series.json에 적어 두고(slot),
   한 번 준 자리는 계속 간다 — 이름 순서로 정하면 테마를 하나 끼워 넣을 때마다 뒤쪽 색이
   전부 밀려서, 어제 파란 선이던 반도체가 오늘 주황이 된다.
   14색은 dataviz 검증 팔레트(인접쌍 통과, 전체쌍 최악 쌍은 13색 때와 동일). 실제 색값은 style.css의 --s1~--s14. */
const SLOTS = 14;
const MARKET_STYLE = {
  KOSPI: { color: "var(--mkt-1)", dash: "", kind: "market" },
  KOSDAQ: { color: "var(--mkt-2)", dash: "5 4", kind: "market" },
};

const PERIODS = Chart.PERIODS;

const $ = (id) => document.getElementById(id);
const state = { index: null, series: null, period: "1y", mode: "abs", view: "overlay", visible: null, markets: null };

/* 보기 방식 — 같은 데이터를 두 가지로 본다.
   겹쳐보기는 테마끼리 직접 비교하는 화면이고, 조망은 "누가 시장을 이기나"를
   한 번에 훑는 화면이다. 어느 쪽도 다른 쪽을 대신하지 못해서 둘 다 둔다. */
const VIEWS = [
  { id: "overlay", label: "겹쳐보기" },
  { id: "grid", label: "조망" },
];

const fmtPct = (v, d = 2) => (v === null || v === undefined ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 사생활 보호 모드 */ } },
};

/* 화면에 올릴 계열 목록. 색은 테마 순서로 고정. */
function allSeries() {
  const s = state.series;
  const markets = s.markets.map((m) => ({
    id: m.id, name: m.name, values: m.values, ...MARKET_STYLE[m.id],
  }));
  const themes = s.themes.map((t, i) => {
    const slot = (t.slot ?? i) % SLOTS;      // slot이 없는 옛 데이터는 순서로 물러선다
    return {
      id: t.id, name: t.name, values: t.values,
      color: `var(--s${slot + 1})`, slot, kind: "theme",
    };
  });
  return { markets, themes };
}

function visibleSeries() {
  const { markets, themes } = allSeries();
  return [...markets.filter((m) => state.markets.includes(m.id)),
          ...themes.filter((t) => state.visible.includes(t.id))];
}

/* 코스피 값은 화면에서 껐어도 필요하다 — 코스피 대비 계산의 분모이자 표의 비교 기준이다. */
function baseValues() {
  const m = allSeries().markets.find((x) => x.id === "KOSPI");
  return m && m.values;
}

/* ── 렌더 ──────────────────────────────────────────────── */
function renderControls() {
  $("periods").innerHTML = PERIODS.map((p) =>
    `<button type="button" class="seg${p.id === state.period ? " on" : ""}" data-p="${p.id}">${p.label}</button>`
  ).join("");
  $("periods").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.period = b.dataset.p; store.set("theme-map:main:period", state.period); draw(); };
  });

  $("modes").innerHTML = [["abs", "절대 수익률"], ["rel", "코스피 대비"]].map(([id, label]) =>
    `<button type="button" class="seg${id === state.mode ? " on" : ""}" data-m="${id}">${label}</button>`
  ).join("");
  $("modes").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.mode = b.dataset.m; store.set("theme-map:main:mode", state.mode); draw(); };
  });

  $("views").innerHTML = VIEWS.map((v) =>
    `<button type="button" class="seg${v.id === state.view ? " on" : ""}" data-v="${v.id}">${v.label}</button>`
  ).join("");
  $("views").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.view = b.dataset.v; store.set("theme-map:main:view", state.view); draw(); };
  });
}

function renderLegend() {
  const { markets, themes } = allSeries();
  const chip = (s, on, clickable, kind) =>
    `<button type="button" class="chip${on ? " on" : ""}${clickable ? "" : " fixed"}"
             ${clickable ? `data-${kind}="${s.id}"` : "disabled"}>
       <i style="background:${s.color}${s.dash ? ";opacity:.75" : ""}"></i>${s.name}</button>`;

  $("legend").innerHTML =
    markets.map((m) => chip(m, state.markets.includes(m.id), true, "m")).join("") +
    themes.map((t) => chip(t, state.visible.includes(t.id), true, "t")).join("");

  $("legend").querySelectorAll("button[data-t]").forEach((b) => {
    b.onclick = () => toggleTheme(b.dataset.t);
  });
  $("legend").querySelectorAll("button[data-m]").forEach((b) => {
    b.onclick = () => toggleMarket(b.dataset.m);
  });

  // 칩에 마우스를 올리면 차트에서 그 선만 남는다 — 켜고 끄지 않고도 찾을 수 있게.
  $("legend").querySelectorAll("button.chip.on").forEach((b) => {
    const id = b.dataset.t || b.dataset.m;
    b.onpointerenter = () => Chart.focus($("chart"), id);
    b.onpointerleave = () => Chart.focus($("chart"), null);
  });
}

/* 테마를 켜고 끈다 — 다른 테마는 건드리지 않는다.
   예전엔 색 자리가 모자라 같은 자리의 테마를 자동으로 껐는데, 사용자가 다른 걸 누르면
   엉뚱한 선이 사라지는 게 더 불편했다(2026-09-10). 테마 수만큼 색을 두는 쪽으로 정리. */
function toggleTheme(id) {
  state.visible = state.visible.includes(id)
    ? state.visible.filter((v) => v !== id)
    : [...state.visible, id];
  store.set("theme-map:main:visible", JSON.stringify(state.visible));
  draw();
}

/* 시장을 이기기 시작한 시점. 판정은 빌드(scripts/build.py rs_signal)에서 한 번만 하고
   화면은 그 값을 보여 주기만 한다 — 알림과 화면이 다른 말을 하면 안 된다. */
function rsCell(r) {
  const rs = r.rs;
  if (!rs) return '<td class="num sub">-</td>';
  const up = rs.state === "above";
  const when = rs.cross_date ? rs.cross_date.slice(5).replace(/^0/, "").replace("-0", "/").replace("-", "/") : "구간 내내";
  const d = rs.days === 0 ? "오늘" : `D+${rs.days}`;
  // 우위만 색을 준다. 열위를 파랑으로 칠하면 '하락'과 헷갈린다 — 열위는 상태일 뿐 방향이 아니다.
  return `<td class="num rs"><span class="pill ${up ? "up" : "dn"}">${up ? "우위" : "열위"} ${d}</span>
    <span class="rs-sub">${when}부터 <b>${fmtPct(rs.excess_since)}%p</b></span></td>`;
}

/* 코스피·코스닥도 테마처럼 껐다 켠다. 코스피를 꺼도 '코스피 대비' 값은 그대로다 —
   비교 기준이 사라지는 게 아니라 선만 감추는 것이다. */
function toggleMarket(id) {
  state.markets = state.markets.includes(id)
    ? state.markets.filter((m) => m !== id)
    : [...state.markets, id];
  store.set("theme-map:markets", JSON.stringify(state.markets));
  draw();
}

/* 값 글자 — 색은 부호만, ±0.5% 미만은 회색으로 물러난다. 큰 움직임만 튀어 보이게. */
function vtxt(v) {
  if (v === null || v === undefined) return '<span class="v flat">-</span>';
  const sign = Math.abs(v) < 0.5 ? "flat" : v > 0 ? "up" : "dn";
  return `<span class="v ${sign}">${fmtPct(v)}</span>`;
}

/* 다이버징 막대. 열 전체가 한 눈금이라 막대 길이 비교가 곧 순위 비교다.
   0선 위치는 그 열의 최소·최대에서 계산한다 — 다 양수인 날은 0선이 왼쪽 끝으로 붙는다. */
function barHtml(v, vals, small) {
  if (v === null || v === undefined) return "";
  const nums = vals.filter((x) => x !== null && x !== undefined);
  const lo = Math.min(0, ...nums), hi = Math.max(0, ...nums);
  const span = hi - lo || 1;
  const z = (0 - lo) / span * 100;
  const w = Math.abs(v) / span * 100;
  const left = v >= 0 ? z : z - w;
  return `<span class="bar${small ? " small" : ""}" aria-hidden="true"><span class="zero" style="left:${z.toFixed(2)}%"></span>
    <span class="fill ${v >= 0 ? "up" : "dn"}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%"></span></span>`;
}

/* 순위표. 색 면적은 '선택한 기간 수익률' 막대 하나뿐이고, 나머지 숫자는 글자색만 쓴다.
   코스피·코스닥은 경쟁자가 아니라 기준선이라 행 대신 구분선으로 그린다 —
   선 위가 그 기간 시장을 이긴 테마, 아래가 진 테마. 색을 안 읽어도 갈린다. */
function renderTable(rows) {
  const period = PERIODS.find((p) => p.id === state.period);
  const rets = rows.map((r) => r.ret);
  const exs = rows.filter((r) => r.kind === "theme").map((r) => r.excess);

  $("rankHead").innerHTML = `
    <tr class="grp"><th></th><th colspan="2"><span>선택한 기간 · ${period.label}</span></th>
      <th colspan="2"><span>단기</span></th><th colspan="2"><span>중장기</span></th><th colspan="2"></th></tr>
    <tr><th>테마</th><th>수익률</th><th>코스피 대비</th><th>1일</th><th>5일</th><th>1개월</th><th>1년</th>
      <th title="상대강도(테마÷코스피)가 20일 이동평균을 넘은 날부터">우위 전환</th><th>종목</th></tr>`;

  $("rankBody").innerHTML = rows.map((r) => {
    if (r.kind === "market") {
      const base = r.id === "KOSPI";
      return `<tr class="base${base ? "" : " kq"}" data-m="${r.id}">
        <td class="name">${r.name}${base ? '<span class="tag">기준선</span>' : ""}</td>
        <td class="num primary">${vtxt(r.ret)}</td>
        <td class="num">${base ? '<span class="base-hint">이 선 위 = 시장을 이김</span>' : fmtPct(r.excess)}</td>
        <td class="num">${fmtPct(r.r1d)}</td><td class="num">${fmtPct(r.r5d)}</td>
        <td class="num">${fmtPct(r.r1m)}</td><td class="num">${fmtPct(r.r1y)}</td>
        <td></td><td></td></tr>`;
    }
    return `<tr class="theme" data-t="${r.id}">
      <td class="name"><a class="go-link" href="theme.html?theme=${encodeURIComponent(r.id)}"><i class="dot" style="background:${r.color}"></i>${r.name}</a></td>
      <td class="num barcell primary">${barHtml(r.ret, rets)}<span class="lbl">${vtxt(r.ret)}</span></td>
      <td class="num barcell">${barHtml(r.excess, exs, true)}<span class="lbl">${vtxt(r.excess)}</span></td>
      <td class="num">${vtxt(r.r1d)}</td><td class="num">${vtxt(r.r5d)}</td>
      <td class="num">${vtxt(r.r1m)}</td><td class="num">${vtxt(r.r1y)}</td>
      ${rsCell(r)}
      <td class="num sub">${r.count ?? "-"}</td>
    </tr>`;
  }).join("");

  $("rankNote").textContent =
    `${state.series.as_of} 종가 · ${period.label} 수익률순 · 코스피 선 위가 시장을 이긴 테마 · 이름을 누르면 구성종목`;

  // 이름은 진짜 링크(a)다 — 새 탭·키보드·모바일에서 확실히 눌린다. 행의 나머지 영역은 onclick으로 받되,
  // 링크 위를 누른 클릭은 브라우저에 맡긴다(두 번 이동 방지).
  $("rankBody").querySelectorAll("tr[data-t]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest("a")) return;
      location.href = `theme.html?theme=${encodeURIComponent(tr.dataset.t)}`;
    };
  });

  // 표에서 행을 훑을 때도 차트가 같이 반응한다 — 순위와 선을 눈으로 잇는 게 이 표의 일이다.
  // 마우스에서만. 터치 기기는 hover 핸들러가 DOM을 바꾸면 첫 탭이 hover로만 소비돼 클릭이 안 먹는다(iOS).
  $("rankBody").querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.t || tr.dataset.m;
    if (!id) return;
    tr.onpointerenter = (e) => { if (e.pointerType === "mouse") Chart.focus($("chart"), id); };
    tr.onpointerleave = (e) => { if (e.pointerType === "mouse") Chart.focus($("chart"), null); };
  });
}

/* 표의 '기간 수익률'은 차트와 같은 시계열·같은 시작점에서 뽑는다.
   지표를 따로 계산하면 차트와 표가 서로 다른 말을 하게 된다. */
function buildRows(from) {
  const meta = {};
  (state.index.markets || []).forEach((m) => { meta[m.id] = m; });
  (state.index.themes || []).forEach((t) => { meta[t.id] = t; });

  const { markets, themes } = allSeries();
  const kospi = markets.find((m) => m.id === "KOSPI");
  const kospiPct = kospi ? Chart.pctFrom(kospi.values, from) : null;
  const kospiRet = kospiPct ? kospiPct[kospiPct.length - 1] : null;

  const rows = visibleSeries().map((s) => {
    const pct = Chart.pctFrom(s.values, from);
    const ret = pct ? pct[pct.length - 1] : null;
    const m = meta[s.id] || {};
    return {
      id: s.id, name: s.name, kind: s.kind, color: s.color,
      ret,
      excess: (ret === null || kospiRet === null) ? null
        : ((100 + ret) / (100 + kospiRet) - 1) * 100,
      r1d: m.r1d, r5d: m.r5d, r1m: m.r1m, r1y: m.r1y, count: m.count, rs: m.rs,
    };
  });
  rows.sort((a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity));
  return rows;
}

function draw() {
  const dates = state.series.dates;
  const from = Chart.fromIndex(dates, PERIODS.find((p) => p.id === state.period));

  renderControls();
  renderLegend();
  // 전환 마커 — 지금 코스피를 이기고 있는 테마가 "언제부터" 이겼는지를 선 위의 점으로 찍는다.
  const marks = (state.index.themes || [])
    .filter((t) => state.visible.includes(t.id) && t.rs
                   && t.rs.state === "above" && t.rs.cross_date)
    .map((t) => ({ id: t.id, date: t.rs.cross_date }));

  const grid = state.view === "grid";
  $("chart").hidden = grid;
  $("grid").hidden = !grid;

  if (grid) {
    // 조망에서는 테마만 칸이 된다 — 코스피는 칸마다 기준선으로 이미 들어가 있다.
    const meta = {};
    (state.index.themes || []).forEach((t) => { meta[t.id] = t; });
    Chart.renderGrid($("grid"), {
      dates, from, mode: state.mode,
      series: visibleSeries().filter((s) => s.kind === "theme")
        .map((s) => ({ ...s, count: (meta[s.id] || {}).count, rs: (meta[s.id] || {}).rs })),
      baseValues: baseValues(),
      href: (c) => `theme.html?theme=${encodeURIComponent(c.id)}`,
    });
  } else {
    Chart.render($("chart"), {
      dates, from, mode: state.mode, baseId: "KOSPI",
      height: innerWidth < 640 ? 300 : 380,
      series: visibleSeries(), baseValues: baseValues(), marks,
    });
  }

  const rows = buildRows(from);
  renderTable(rows);
  $("chartNote").textContent = grid
    ? (state.mode === "rel"
        ? "점선이 코스피 · 선이 점선 위면 그 기간 시장을 이긴 것 · 칸끼리 같은 눈금"
        : `${dates[from]} 종가 = 0% 기준 · 회색 선이 코스피 · 칸끼리 같은 눈금`)
    : (state.mode === "rel"
        ? `${dates[from]} 이후 코스피 대비 초과수익 · 0%선이 코스피`
        : `${dates[from]} 종가 = 0% 기준`)
      + (marks.length ? " · ◉ 는 코스피를 이기기 시작한 날" : "");
}

function initThemeToggle() {
  const root = document.documentElement;
  const saved = store.get("theme-map:mode", null);
  if (saved) root.setAttribute("data-theme", saved);
  $("themeToggle").onclick = () => {
    const now = root.getAttribute("data-theme");
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const next = now === "dark" ? "light" : now === "light" ? "dark" : dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store.set("theme-map:mode", next);
  };
}

async function init() {
  initThemeToggle();
  const [index, series] = await Promise.all([
    fetch("data/index.json").then((r) => r.json()),
    fetch("data/series.json").then((r) => r.json()),
  ]);
  state.index = index;
  state.series = series;

  // URL 파라미터는 저장된 설정보다 우선하되 저장하지는 않는다 — 텔레그램용 캡처(theme-map-alert)가
  // ?period=1w&all=1 로 열어 순위표를 찍는다. 사람이 그 링크를 열어도 자기 설정이 덮이지 않는다.
  const q = new URL(location.href).searchParams;
  state.period = q.get("period") || store.get("theme-map:main:period", "1y");
  state.mode = q.get("mode") || store.get("theme-map:main:mode", "abs");
  state.view = q.get("view") || store.get("theme-map:main:view", "overlay");
  if (!PERIODS.some((p) => p.id === state.period)) state.period = "1y";
  if (!["abs", "rel"].includes(state.mode)) state.mode = "abs";
  if (!VIEWS.some((v) => v.id === state.view)) state.view = "overlay";

  const ids = series.themes.map((t) => t.id);
  let saved = null;
  try { saved = JSON.parse(store.get("theme-map:main:visible", "null")); } catch (e) { /* noop */ }
  state.visible = Array.isArray(saved) ? saved.filter((v) => ids.includes(v)) : ids.slice(0, SLOTS);
  if (!state.visible.length) state.visible = ids.slice(0, SLOTS);

  const mids = series.markets.map((m) => m.id);
  let savedM = null;
  try { savedM = JSON.parse(store.get("theme-map:markets", "null")); } catch (e) { /* noop */ }
  state.markets = Array.isArray(savedM) ? savedM.filter((m) => mids.includes(m)) : mids;
  if (q.get("all") === "1") { state.visible = ids; state.markets = mids; }

  $("asOf").textContent = series.as_of;
  $("updatedAt").textContent = index.updated_at;
  draw();

  let t = null;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(draw, 160); });
}

init().catch((e) => {
  $("chart").innerHTML = `<p class="chart-empty">데이터를 불러오지 못했습니다 — ${e}</p>`;
});
