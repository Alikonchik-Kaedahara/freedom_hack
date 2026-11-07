# results/

Сюда выгружаются файлы для организаторов: `dev/results.json` (все 65 диалогов DEV) и `prod/results.json`
(10 контрольных чатов). Создаются кнопкой «Выгрузить» на экране «Диалоги» или командами
`python manage.py export DEV dev` и `python manage.py prod <group_id>`; проверка — `python manage.py check dev|prod`.
Файлы должны быть закоммичены и запушены до стоп-кода.
