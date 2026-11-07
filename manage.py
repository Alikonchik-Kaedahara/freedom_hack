"""Service commands for the CQA prototype.

  python manage.py snapshot            copy datasets, results and checklists from storage/ to demo/snapshot/
                                       (commit it so the demo replays without a key; API keys are never copied)
  python manage.py restore             copy demo/snapshot/ back into storage/ (--force overwrites existing files)
  python manage.py load-sample         import the synthetic dialogs from demo/sample/dataset.json as group SAMPLE
  python manage.py update-defaults     save the built-in checklists from cqa/defaults.py as new versions of
                                       chat-base / call-base (use after the default rules change)
  python manage.py export GROUP dev    write results/dev/results.json for a dataset group (or ... prod)
                                       options: --team "Name"  --allow-replay
  python manage.py prod GROUP_ID       the control hour: import GROUP_ID from the organizers' API, evaluate
                                       every dialog with the current engine, write results/prod/results.json,
                                       check it and print what is left to do (commit + push)
  python manage.py check dev|prod      validate an existing results/<set>/results.json against the format
  python manage.py test                run the Python and JavaScript test suites
"""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from cqa import export, replay, scoring, storage  # noqa: E402
from cqa.defaults import DEFAULT_CHECKLISTS  # noqa: E402
from cqa.evaluator import EvaluationError, check_engine, evaluate  # noqa: E402
from cqa.validation import ValidationError, validate_records  # noqa: E402


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _flag(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        return argv[i + 1] if i + 1 < len(argv) else default
    return default


def _team(argv):
    return _flag(argv, "--team") or storage.get_settings().get("teamName") or os.environ.get("CQA_TEAM_NAME") or "freedom_hack"


def _load_dotenv():
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


def import_group(group_id):
    """GET the organizers' API and store the group. Returns the dataset meta."""
    import requests

    url = os.environ.get("CQA_DATA_API", "").strip()
    if not url:
        raise SystemExit("Не задан CQA_DATA_API в .env (ссылка GET из задания)")
    r = requests.get(url, params={"group_id": group_id}, timeout=120)
    payload = r.json()
    if not payload.get("isSuccess"):
        raise SystemExit(f"API вернуло ошибку: {payload.get('error') or r.status_code}")
    try:
        records = validate_records(payload)
    except ValidationError as e:
        raise SystemExit(f"Неожиданный формат ответа API: {e}")
    meta = storage.save_dataset(group_id, records, now())
    storage.save_settings({"activeGroup": group_id})
    return meta


def evaluate_group(group_id, workers=4):
    """Evaluate every dialog of a group with the engine from settings. Returns (ok, failed)."""
    settings = storage.get_settings()
    if settings.get("engine") == "replay":
        raise SystemExit("Движок replay воспроизводит сохранённые ответы — для реальной оценки выберите cloud или local "
                         "(экран «Модель» или PUT /api/settings).")
    status = check_engine(settings)
    if not status["ok"]:
        raise SystemExit(status["message"])
    records = storage.get_dataset(group_id)
    if not records:
        raise SystemExit(f"Набор «{group_id}» не загружен")
    active = settings.get("active", {})
    ok = failed = 0
    started = time.time()

    def one(rec):
        cid = rec["conversation_id"]
        key = storage.result_key(group_id, cid)
        checklist = storage.get_checklist(active.get(rec.get("channel")) or "")
        try:
            if not checklist:
                raise EvaluationError("Нет чек-листа для этого канала")
            t0 = time.time()
            answers, usage, engine, meta = evaluate(rec, checklist, settings)
            result = {"key": key, "groupId": group_id, "conversationId": cid, "checklist": checklist,
                      "answers": answers, "appeals": [], "engine": engine, "usage": usage,
                      "durationMs": int((time.time() - t0) * 1000), "attempts": meta["attempts"],
                      "promptHash": meta["promptHash"], "unresolved": meta["unresolved"], "createdAt": now()}
            result["score"] = scoring.summarize(result)
            storage.put_result(result)
            storage.clear_failure(key)
            return cid, None, result["score"]["total"], meta["unresolved"]
        except Exception as e:  # noqa: BLE001 - keep the batch going, record the failure
            storage.put_failure(key, group_id, cid, str(e), now())
            return cid, str(e), None, []

    with ThreadPoolExecutor(max_workers=1 if settings.get("engine") == "local" else workers) as pool:
        for cid, err, total, unresolved in pool.map(one, records):
            if err:
                failed += 1
                print(f"  ✗ {cid}: {err}")
            else:
                ok += 1
                flag = f"  (требует проверки: {', '.join(p['criterionId'] for p in unresolved)})" if unresolved else ""
                print(f"  ✓ {cid}: {total}{flag}")
    print(f"Оценено {ok}, ошибок {failed}, {int(time.time() - started)} с")
    return ok, failed


def do_export(group_id, dataset, team, allow_replay):
    doc, report = export.write(group_id, dataset, team, allow_replay)
    problems = export.check(doc)
    print(f"{report['path']}: записей {report['total']}, ok {report['ok']}, error {report['error']}, "
          f"model.mode={report['mode']} ({report['modelName']}), team={team}")
    for cid, reason in report["errors"].items():
        print(f"  error {cid}: {reason}")
    if report["replay"] and not allow_replay:
        print(f"  {len(report['replay'])} результатов получены движком replay и выгружены как error "
              "(оцените их реальной моделью или добавьте --allow-replay)")
    if problems:
        print("ПРОБЛЕМЫ ФОРМАТА:")
        for p in problems:
            print("  -", p)
    else:
        print("Формат проверен: проблем нет")
    return report, problems


def main(argv):
    _load_dotenv()
    cmd = argv[1] if len(argv) > 1 else "help"
    if cmd == "snapshot":
        copied = replay.export_snapshot()
        print("Снимок сохранён в demo/snapshot: " + (", ".join(copied) if copied else "нечего копировать (storage пуст)"))
    elif cmd == "restore":
        restored = replay.restore_snapshot(force="--force" in argv)
        print("Восстановлено: " + (", ".join(restored) if restored else "ничего (файлы уже есть, используйте --force)"))
    elif cmd == "load-sample":
        meta = replay.load_sample()
        print(f"Набор {meta['groupId']}: {meta['total']} диалогов" if meta else "demo/sample/dataset.json не найден")
    elif cmd == "update-defaults":
        for cl in DEFAULT_CHECKLISTS:
            item = json.loads(json.dumps(cl))
            item["updatedAt"] = now()
            saved = storage.save_checklist(item)
            print(f"{saved['id']}: версия {saved['version']} сохранена из cqa/defaults.py")
    elif cmd == "export":
        if len(argv) < 4 or argv[3] not in ("dev", "prod"):
            raise SystemExit("Использование: python manage.py export GROUP dev|prod [--team NAME] [--allow-replay]")
        _, problems = do_export(argv[2], argv[3], _team(argv), "--allow-replay" in argv)
        sys.exit(1 if problems else 0)
    elif cmd == "prod":
        if len(argv) < 3:
            raise SystemExit("Использование: python manage.py prod GROUP_ID [--team NAME]")
        group_id = argv[2]
        print(f"1/3 Импорт набора {group_id} из API организаторов…")
        meta = import_group(group_id)
        print(f"    {meta['total']} диалогов: {meta['chats']} чатов, {meta['calls']} звонков")
        print("2/3 Оценка…")
        evaluate_group(group_id)
        print("3/3 Выгрузка results/prod/results.json…")
        report, problems = do_export(group_id, "prod", _team(argv), False)
        print("\nОсталось сделать вручную:")
        print("  git add results/prod/results.json && git commit -m \"Control set results\" && git push")
        print("  и убедиться, что файл виден в открытом репозитории до стоп-кода.")
        sys.exit(1 if problems or report["error"] else 0)
    elif cmd == "check":
        dataset = argv[2] if len(argv) > 2 else "dev"
        path = os.path.join(export.RESULTS_DIR, dataset, "results.json")
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        expected = 10 if dataset == "prod" else None
        problems = export.check(doc, expected_count=expected)
        print(f"{os.path.relpath(path, ROOT)}: записей {len(doc.get('results', []))}")
        for p in problems:
            print("  -", p)
        print("Формат проверен: проблем нет" if not problems else f"Проблем: {len(problems)}")
        sys.exit(1 if problems else 0)
    elif cmd == "test":
        code = subprocess.call([sys.executable, "-m", "pytest", "-q", "tests"], cwd=ROOT)
        code |= subprocess.call(["node", "--test", "tests/scoring.test.mjs"], cwd=ROOT)
        sys.exit(code)
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
