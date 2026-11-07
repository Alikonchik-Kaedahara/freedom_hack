"""Service commands for the CQA prototype.

  python manage.py snapshot      copy datasets, results and checklists from storage/ to demo/snapshot/
                                 (commit it so the demo replays without a key; API keys are never copied)
  python manage.py restore       copy demo/snapshot/ back into storage/ (--force overwrites existing files)
  python manage.py load-sample   import the synthetic dialogs from demo/sample/dataset.json as group SAMPLE
  python manage.py test          run the Python and JavaScript test suites
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from cqa import replay  # noqa: E402


def main(argv):
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
    elif cmd == "test":
        code = subprocess.call([sys.executable, "-m", "pytest", "-q", "tests"], cwd=ROOT)
        code |= subprocess.call(["node", "--test", "tests/scoring.test.mjs"], cwd=ROOT)
        sys.exit(code)
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
