# Herdr worker tools

Два мода для управления воркерами через `hc`. Общее ядро собирает аргументы без shell, проверяет принадлежность терминалов и возвращает стабильный конверт результата.

Нужны Node.js 22+, npm, `hc` в PATH и движок модов версии 2.1.322. При обновлении движка повторите проверку типов и валидацию.

```bash
npm install
npm run build
MOD_API_TYPES=/absolute/path/to/runtime-api.d.ts npm run typecheck
npm test
claude plugin validate dist/herdr-orchestrator
claude plugin validate dist/herdr-worker
```

`MOD_API_TYPES` указывает на декларации установленного движка из встроенного навыка `plugin-authoring` (`types/claude-code.d.ts`). Первый запуск копирует их в кеш `node_modules`; последующие `npm run typecheck` используют кеш. Декларации в репозиторий не входят. Сборка встраивает ядро в каждый плагин, внешних runtime-импортов нет.

Установка — вручную после сборки. `node scripts/install.mjs` печатает команды для текущего checkout и ничего не устанавливает:

```bash
claude plugin marketplace add /absolute/path/to/checkout
claude plugin install herdr-orchestrator@herdr-setup --scope user
claude plugin install herdr-worker@herdr-setup --scope user
claude plugin enable herdr-orchestrator@herdr-setup --scope user
claude plugin enable herdr-worker@herdr-setup --scope user
```

В пользовательские настройки добавьте allow-правила, сохранив остальные настройки:

```json
{"permissions":{"allow":["mcp__herdr-orchestrator__*","mcp__herdr-worker__*"]}}
```

Затем `/reload-plugins`. Marketplace использует относительные пути к `dist`; сохраняйте checkout с собранными артефактами. Для разработки передайте обе папки через повторенный `--plugin-dir`.

Без `HC_TERMINAL_ID` инструменты не регистрируются. При пустом `HC_PARENT` доступны семь инструментов ведущего: `worker_spawn`, `worker_list`, `worker_send`, `worker_wait`, `worker_read`, `worker_stop`, `worker_templates`. При заданном `HC_PARENT` доступны только `report` и `ask_owner`. Вложенные агенты получают отказ. Перед изменяющей операцией проверяются разрешения движка.

`worker_spawn` принимает шаблон и первую задачу либо массив аргументов программы без задачи. `worktree` — корень существующего Git checkout; мод его не создает. Список содержит только живых детей текущего терминала. `worker_stop` вызывайте только по явной просьбе пользователя; удаление записи требует `remove: true`.

Ответы имеют вид `{ok:true,data}` или `{ok:false,error,data}`. Ошибка с `effect: applied` несет частичный результат; `unknown` запрещает слепой повтор. `worker_wait` по умолчанию ждет любого ребенка 180 секунд, максимум 540 секунд; контрольный таймаут — обычный результат.

Отчеты идут только родителю. Повтор с тем же `requestId` и содержимым не отправляется заново; другое содержимое с тем же ключом дает конфликт. Без `requestId` используется хэш содержимого и окно 60 секунд. Журнал хранится в store до семи дней, максимум 500 записей. Неизвестный исход доставки остается неизвестным после перезагрузки: гарантии exactly-once у `hc` нет. Новый `requestId` может повторить доставку. Лимиты: текст 32768 символов, экран 65536 символов, история 1000 строк.

Тесты используют fake transport и не создают терминалов. Живую проверку ролей, разрешений, первой задачи и доставки отчета выполняйте отдельно в разрешенной среде.
