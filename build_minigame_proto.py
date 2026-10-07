"""미니게임 시험장 페이지 빌드.

minigames.css + minigames.js 를 minigame_proto_page.html 템플릿에 인라인해서
  - minigame_proto.html          : 로컬 테스트용 완전한 문서 (doctype 포함)
  - minigame_proto_artifact.html : Artifact 게시용 조각 (doctype/html/head/body 없음 -- 게시 도구가 감싼다)
를 만든다. 게임 본체에 합칠 때도 같은 minigames.css / minigames.js 를 build_client.py 가 인라인하면 된다.
"""
import pathlib

here = pathlib.Path(__file__).parent
css = (here / "minigames.css").read_text(encoding="utf-8")
js = (here / "minigames.js").read_text(encoding="utf-8")
page = (here / "minigame_proto_page.html").read_text(encoding="utf-8")

assert "</script" not in js, "minigames.js 안에 </script 가 있으면 인라인이 깨진다"
for marker in ("/*__MG_CSS__*/", "/*__MG_JS__*/"):
    assert page.count(marker) == 1, marker + " 자리표시자는 템플릿에 정확히 한 번 있어야 한다"

frag = page.replace("/*__MG_CSS__*/", css).replace("/*__MG_JS__*/", js)
(here / "minigame_proto_artifact.html").write_text(frag, encoding="utf-8")

full = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n'
        + frag + "\n</body>\n</html>\n")
(here / "minigame_proto.html").write_text(full, encoding="utf-8")
print("built:", len(frag) // 1024, "KB fragment,", len(full) // 1024, "KB full")
