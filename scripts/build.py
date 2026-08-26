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

_history_cache = {}


def symbol_of(stock: dict) -> str:
    return f"{stock['code']}.{stock['market']}"


def history(symbol: str):
    """같은 종목이 여러 테마에 걸쳐 있어도 수집은 한 번만 한다."""
    if symbol not in _history_cache:
        _history_cache[symbol] = core.fetch_history(symbol)
    return _history_cache[symbol]


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
            "order": st.get("order"), **m,
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

    # 대테마 지수 — 동일가중. 최근 5년만 쓴다.
    # 그 이전 구간은 상장 종목이 한둘뿐이라(원자력이면 2000년대엔 두산에너빌리티 하나) 테마 지수가 아니다.
    index_series = core.equal_weight_index(closes).tail(core.INDEX_KEEP_DAYS)
    index_metrics = core.compute_metrics(index_series)
    index_metrics["basis"] = "동일가중 지수 (구성종목 일간수익률 평균 누적, 최근 5년 구간)"
    index_metrics.pop("close", None)          # 지수 레벨은 표에 쓰지 않는다
    # 테마의 '사상 고점'은 구성종목이 계속 바뀌므로 의미가 없다 — 52주만 남긴다.
    for k in ("from_all_high", "high_all", "high_all_date"):
        index_metrics[k] = None
    index_metrics["count"] = len(rows)

    now = datetime.now(KST)
    return {
        "theme": {"id": theme, "name": theme},
        "as_of": rows[0]["as_of"],
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "period_mode": core.PERIOD_MODE,
        "index": index_metrics,
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
    summaries, failed = [], []
    for theme in wanted:
        print(f"  [{theme}] 수집… ({len(by_theme[theme])}종목)")
        try:
            payload = build_theme(theme, by_theme[theme])
        except Exception as e:  # noqa: BLE001
            failed.append(theme)
            print(f"  [FAIL] {theme}: {e}", file=sys.stderr)
            continue
        (THEMES_DIR / f"{theme}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        summaries.append({
            "id": theme, "name": theme,
            "count": payload["index"]["count"],
            "as_of": payload["as_of"],
            **{k: payload["index"].get(k) for k in
               ("r1d", "r5d", "r1m", "r1y", "from_52w_high", "from_all_high")},
        })

    if not summaries:
        print("모든 테마 실패 — 기존 JSON을 유지합니다.", file=sys.stderr)
        return 1

    now = datetime.now(KST)
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "index.json").write_text(json.dumps({
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "as_of": summaries[0]["as_of"],
        "period_mode": core.PERIOD_MODE,
        "universe_source": universe.get("source", "unknown"),
        "themes": summaries,
        "failed_themes": failed,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  완료 — 테마 {len(summaries)}개" + (f", 실패 {len(failed)}개" if failed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
