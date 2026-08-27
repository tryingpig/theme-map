#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""테마 맵 드라이버 — data/universe.json을 읽어 테마별 JSON을 만든다.

  python scripts/build.py            # 유니버스에 있는 모든 대테마
  python scripts/build.py 원자력 조선  # 지정한 대테마만

계층은 **대테마 > 역할 > 종목** 이다.
대테마와 역할 그룹은 단순 나열이 아니라 각각 집계값을 갖는다:
  · 대테마 = 구성종목 동일가중 지수(core.equal_weight_index)에서 뽑은 지표 — 테마 자체의 수익률
  · 역할   = 구성종목 지표의 단순 평균 — "오늘은 정비주가 갔고 EPC는 안 갔다"를 보는 축
표시 순서는 별도 필드 없이 정렬순서(숫자)로 정한다. 역할 그룹 순서 = 그룹 내 정렬순서 최솟값.
"""

import io
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import core

# 윈도우 콘솔(cp949)에서 한글·em dash 출력이 UnicodeEncodeError로 죽는 걸 막는다.
for _name in ("stdout", "stderr"):
    _s = getattr(sys, _name)
    if getattr(_s, "encoding", "").lower() not in ("utf-8", "utf8"):
        setattr(sys, _name, io.TextIOWrapper(_s.buffer, encoding="utf-8", errors="replace"))

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
THEMES_DIR = DATA / "themes"
UNIVERSE = DATA / "universe.json"
KST = timezone(timedelta(hours=9))
CAP_THRESHOLD = 5000e8      # 시총 5,000억 — 화면의 '시총 5천억 이상만' 필터 기준

_history_cache = {}


def symbol_of(stock: dict) -> str:
    return f"{stock['code']}.{stock['market']}"


def history(symbol: str):
    """같은 종목이 여러 테마에 걸쳐 있어도 수집은 한 번만 한다."""
    if symbol not in _history_cache:
        _history_cache[symbol] = core.fetch_history(symbol)
    return _history_cache[symbol]


def load_json(path: Path):
    """이미 저장된 JSON을 읽는다. 없거나 깨졌으면 None."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def summarize(payload: dict) -> dict:
    """테마 JSON에서 index.json에 실을 요약 한 줄을 뽑는다."""
    return {
        "id": payload["theme"]["id"], "name": payload["theme"]["name"],
        "count": payload["index"]["count"],
        "as_of": payload["as_of"],
        **{k: payload["index"].get(k) for k in
           ("r1d", "r5d", "r1m", "r1y", "from_52w_high", "from_all_high")},
    }


def load_universe() -> dict:
    if not UNIVERSE.exists():
        raise SystemExit(
            f"{UNIVERSE} 없음 — 노션 동기화(scripts/sync_from_notion.py)를 먼저 실행하세요."
        )
    return json.loads(UNIVERSE.read_text(encoding="utf-8"))


def build_theme(theme: str, stocks: list) -> dict:
    """대테마 하나를 통째로 계산한다. 실패 종목은 건너뛰고 errors에 남긴다."""
    rows, closes, errors = [], [], []

    for st in sorted(stocks, key=lambda s: (s.get("order") or 9999, s["name"])):
        sym = symbol_of(st)
        try:
            df = history(sym)
            m = core.compute_metrics(df["Close"], df.get("High"))
        except Exception as e:  # noqa: BLE001
            errors.append({"name": st["name"], "symbol": sym, "error": str(e)})
            print(f"    [FAIL] {st['name']}({sym}): {e}", file=sys.stderr)
            continue
        rows.append({
            "name": st["name"], "code": st["code"], "market": st["market"],
            "symbol": sym, "role": st.get("role") or "기타",
            "desc": st.get("desc", ""), "note": st.get("note", ""),
            "order": st.get("order"), "market_cap": core.fetch_market_cap(sym), **m,
        })
        closes.append(df["Close"].dropna())
        print(f"    [OK] {st['name']:10s} {m['close']:>10,.0f}  1일 {m['r1d']:>7}  "
              f"1년 {m['r1y']:>8}  52주고점대비 {m['from_52w_high']:>7}")

    if not rows:
        raise RuntimeError(f"{theme}: 수집 성공 종목이 없음")

    # 역할 그룹 — 순서는 그룹 내 정렬순서 최솟값
    by_role = {}
    for r in rows:
        by_role.setdefault(r["role"], []).append(r)
    groups = []
    for role, members in by_role.items():
        groups.append({
            "role": role,
            "order": min((m["order"] or 9999) for m in members),
            "summary": core.average_metrics(members),
            "stocks": members,
        })
    groups.sort(key=lambda g: g["order"])

    def make_index(series_list, count):
        """구성종목 종가들로 동일가중 지수를 만들고 지표를 뽑는다. 최근 5년 구간만 쓴다.
        그 이전은 상장 종목이 한둘뿐이라(원자력이면 2000년대엔 두산에너빌리티 하나) 테마 지수가 아니다."""
        if not series_list:
            return None
        s = core.equal_weight_index(series_list).tail(core.INDEX_KEEP_DAYS)
        m = core.compute_metrics(s)
        m["basis"] = "동일가중 지수 (구성종목 일간수익률 평균 누적, 최근 5년 구간)"
        m.pop("close", None)          # 지수 레벨은 표에 쓰지 않는다
        # 테마의 '사상 고점'은 구성종목이 계속 바뀌므로 의미가 없다 — 52주만 남긴다.
        for k in ("from_all_high", "high_all", "high_all_date"):
            m[k] = None
        m["count"] = count
        return m

    index_metrics = make_index(closes, len(rows))

    # 시총 필터를 켰을 때 쓸 지수. 지수는 시계열이 있어야 만들 수 있어 프론트에서 계산할 수 없다.
    large = [(r, c) for r, c in zip(rows, closes)
             if r.get("market_cap") and r["market_cap"] >= CAP_THRESHOLD]
    index_large = make_index([c for _, c in large], len(large))

    now = datetime.now(KST)
    return {
        "theme": {"id": theme, "name": theme},
        # 종목마다 마지막 거래일이 다를 수 있다(거래정지 등) — 가장 최근 것을 그 테마의 기준일로 본다.
        "as_of": max(r["as_of"] for r in rows),
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "period_mode": core.PERIOD_MODE,
        "index": index_metrics,
        "index_large": index_large,          # 시총 필터를 켰을 때 쓰는 지수
        "cap_threshold": CAP_THRESHOLD,
        "groups": groups,
        "errors": errors,
    }


def main(argv: list) -> int:
    universe = load_universe()
    stocks = [s for s in universe.get("stocks", []) if s.get("active", True)]
    if not stocks:
        raise SystemExit("유니버스가 비었습니다.")

    by_theme = {}
    for st in stocks:
        for t in st.get("themes", []):
            by_theme.setdefault(t, []).append(st)

    wanted = argv or sorted(
        by_theme, key=lambda t: min((s.get("order") or 9999) for s in by_theme[t])
    )
    unknown = [t for t in wanted if t not in by_theme]
    if unknown:
        raise SystemExit(f"유니버스에 없는 테마: {', '.join(unknown)}")

    THEMES_DIR.mkdir(parents=True, exist_ok=True)
    summaries, failed, stale = [], [], []
    for theme in wanted:
        print(f"  [{theme}] 수집… ({len(by_theme[theme])}종목)")
        out_path = THEMES_DIR / f"{theme}.json"
        prev = load_json(out_path)

        try:
            payload = build_theme(theme, by_theme[theme])
        except Exception as e:  # noqa: BLE001
            failed.append(theme)
            print(f"  [FAIL] {theme}: {e}", file=sys.stderr)
            if prev:
                summaries.append(summarize(prev))   # 기존 값으로 탭은 살려 둔다
            continue

        # 데이터 퇴행 방지 — 새로 받은 기준일이 이미 저장된 것보다 이전이면 덮어쓰지 않는다.
        # 야후가 자정 무렵 최신 거래일 봉을 일시적으로 빼고 주는 일이 있어서(2026-08-27 00:03에 재현),
        # 그대로 쓰면 사이트가 하루 뒤로 되돌아간다.
        if prev and payload["as_of"] < prev.get("as_of", ""):
            stale.append(theme)
            print(f"  [SKIP] {theme}: 받은 기준일 {payload['as_of']} < 저장된 {prev['as_of']} "
                  f"— 데이터 퇴행이라 기존 파일 유지", file=sys.stderr)
            summaries.append(summarize(prev))
            continue

        out_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        summaries.append(summarize(payload))

    if not summaries:
        print("모든 테마 실패 — 기존 JSON을 유지합니다.", file=sys.stderr)
        return 1

    now = datetime.now(KST)
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "index.json").write_text(json.dumps({
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "as_of": max(s["as_of"] for s in summaries),
        "period_mode": core.PERIOD_MODE,
        "universe_source": universe.get("source", "unknown"),
        "themes": summaries,
        "failed_themes": failed,
        "stale_themes": stale,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  완료 — 테마 {len(summaries)}개"
          + (f", 실패 {len(failed)}개" if failed else "")
          + (f", 퇴행방지로 유지 {len(stale)}개" if stale else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
