#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""노션 'Theme Map DB' → data/universe.json (테마 맵 유니버스).

build.py가 읽는 추적 대상 목록을 노션에서 받아 온다. Actions에서 수집 직전에 돌기 때문에
노션 편집이 매 수집분에 바로 반영된다. 새 테마를 늘릴 때 코드를 고칠 일이 없는 게 핵심이다
— 노션 '대테마' multi-select에 옵션을 추가하고 종목에 태깅하면 웹에 탭이 자동으로 생긴다.

- 대상: 활성=True 행.
- 토큰: 환경변수 NOTION_TOKEN (Actions Secret, stock-disparity와 같은 인티그레이션).
- 노션 조회 실패 시: 기존 universe.json이 있으면 그대로 두고 경고만(폴백), 없으면 실패.
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 윈도우 콘솔(cp949)에서 한글 출력이 UnicodeEncodeError로 죽는 걸 막는다.
for _name in ("stdout", "stderr"):
    _s = getattr(sys, _name)
    if getattr(_s, "encoding", "").lower() not in ("utf-8", "utf8"):
        setattr(sys, _name, io.TextIOWrapper(_s.buffer, encoding="utf-8", errors="replace"))

DB_ID = "069bc086b447427b9b6da0dd39f9e0e3"
BASE = "https://api.notion.com/v1"
OUT = Path(__file__).resolve().parent.parent / "data" / "universe.json"
KST = timezone(timedelta(hours=9))


def api(method, path, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def _text(prop):
    if not prop:
        return ""
    arr = prop.get("rich_text") or prop.get("title") or []
    return "".join(t.get("plain_text", "") for t in arr).strip()


def _select(prop):
    v = (prop or {}).get("select")
    return v["name"].strip() if v else ""


def _multi(prop):
    return [o["name"].strip() for o in (prop or {}).get("multi_select", [])]


def fetch_rows(token):
    rows, cursor = [], None
    while True:
        payload = {"page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor
        res = api("POST", f"/databases/{DB_ID}/query", token, payload)
        for r in res["results"]:
            p = r["properties"]
            rows.append({
                "name": _text(p.get("종목명")),
                "code": _text(p.get("종목코드")),
                "market": _select(p.get("시장")),
                "themes": _multi(p.get("대테마")),
                "role": _select(p.get("역할")),
                "desc": _text(p.get("사업내용")),
                "note": _text(p.get("비고")),
                "order": (p.get("정렬순서") or {}).get("number"),
                "active": bool((p.get("활성") or {}).get("checkbox")),
            })
        if not res.get("has_more"):
            break
        cursor = res["next_cursor"]
    return rows


def main() -> int:
    token = os.environ.get("NOTION_TOKEN", "").strip()
    if not token:
        return fallback("NOTION_TOKEN 환경변수 없음")

    try:
        rows = fetch_rows(token)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        return fallback(f"노션 조회 실패 HTTP {e.code} — {detail}")
    except Exception as e:  # noqa: BLE001
        return fallback(f"노션 조회 실패 — {e}")

    stocks, skipped = [], []
    for r in rows:
        if not r["active"]:
            continue
        if not (r["name"] and r["code"] and r["market"] and r["themes"]):
            skipped.append(r["name"] or "(이름 없음)")
            continue
        stocks.append(r)

    if not stocks:
        return fallback("활성 종목 0건 (노션은 응답했으나 조건에 맞는 행이 없음)")

    stocks.sort(key=lambda s: (s.get("order") or 9999, s["name"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "updated_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
        "source": "notion",
        "stocks": stocks,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    themes = sorted({t for s in stocks for t in s["themes"]})
    print(f"[OK] {OUT.name} 갱신 — 종목 {len(stocks)}개, 테마 {len(themes)}개 ({', '.join(themes)})")
    if skipped:
        print(f"     필수값 누락으로 건너뜀: {', '.join(skipped)}", file=sys.stderr)
    return 0


def fallback(reason: str) -> int:
    """노션이 안 되더라도 직전 유니버스가 있으면 수집은 계속 굴러가게 둔다."""
    if OUT.exists():
        print(f"[WARN] {reason} — 기존 {OUT.name} 유지", file=sys.stderr)
        return 0
    print(f"[FAIL] {reason} — 폴백할 {OUT.name}도 없음", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
