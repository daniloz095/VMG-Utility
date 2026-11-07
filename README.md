# VMG-Utility — *ultimate driving data*

Приложение **M Vitals+** для головной части MGU (BMW iDrive 7): буст, температуры,
давление масла, лямбда, детонация, ВТНП, электрика, раздатка и лаг-таймер — прямо
на экране мультимедиа, с чтением живых данных из DME по UDS/OBD.

Репозиторий содержит само приложение, полный тулчейн (сборка → эмулятор → установка)
и инструкции. Установка на машину — одной командой PowerShell по SSH.

---

## Возможности приложения

Десять вкладок (листание — кнопками внизу экрана):

| Вкладка | Что показывает |
|---|---|
| **MAIN** | буст, обороты, температуры двигателя/масла, скорость, давление масла |
| **POWER** | нагрузка, момент, наддув — сводная мощность |
| **HPFP** | давление в рампле: факт/запрос + живой график |
| **IGNITION** | угол опережения, коррекция по детонации, лямбда, адаптация смеси |
| **FUEL/COOL** | топливо, температура выхлопа, радиатор, вентилятор, термостат |
| **ELEC** | напряжение бортовой сети, ток, нагрузка генератора |
| **TCASE** | блокировка муфты xDrive, проскальзывание |
| **LAP** | лаг-таймер с детализацией по POWER / HPFP / IGNITION |
| **MORE** | BOOST / GEAR CORRECTION / EXHAUST / LOGS / PROFILES |
| **SETTINGS** | источник буста, единицы, язык EN/RU, demo-режим, интервал опроса |

Данные берутся из двух источников: сигналы кластера (CDS/Vehicle2/FES) и прямые
UDS-запросы DID к DME (ecu 18), КПП (ecu 24) и раздатке (ecu 26). Масштабирование
сырых значений задано в `apps/m_vitals_plus/app.json` (`config.scaling`,
`config.dme`) — кандидаты DID перебираются по порядку, первое правдоподобное
значение попадает на плитку; сырые значения пишутся в лог для калибровки под
конкретный двигатель.

---

## Быстрый старт (Windows, машина подключена по enet)

```powershell
# однострочник — скачает готовый пакет из GitHub Releases и установит (репозиторий не нужен):
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/daniloz095/VMG-Utility/main/kit/tools/install.ps1))) -HostName 172.16.0.1
```

Скрипт скачает `.mgu` из последнего релиза GitHub, подключится к HU по SSH вашим
ключом, установит приложение в `/var/opt/private/oap/m_vitals_plus/` и перезапустит
`oap-mainapp`. Для установки нужны только Windows + OpenSSH-клиент (Python/Node/SDK
не требуются). Сборка выполняется автоматически в GitHub Actions при релизе — см.
[«Публикация релизов»](#публикация-релизов). Пошаговая PowerShell-инструкция —
[docs/INSTALL-POWERSHELL.md](docs/INSTALL-POWERSHELL.md); полное руководство —
[docs/INSTALL-ON-CAR.md](docs/INSTALL-ON-CAR.md).

### Требования

| Компонент | Зачем | Примечание |
|---|---|---|
| Python 3 | сборка (`build.py`), деплой (`deploy.py`) | на PATH |
| Node.js | browserify-бандл, эмулятор | точное совпадение рантайма — Node 8; новые версии работают для сборки |
| OpenSSH клиент | SSH/SCP до HU | встроен в Windows 10+ («Optional feature») |
| SSH-ключ root на HU | доступ к головной части | по умолчанию `C:\Users\dmpol\.ssh\mgu_root_key` |
| `oap-sdk` | код BMW, нужен для сборки `.mgu` | однократно извлекается с машины — см. [docs/OAP-SDK.md](docs/OAP-SDK.md) |

---

## Структура репозитория

```
apps/m_vitals_plus/          исходники приложения
  main.js                    UI и логика (canvas-рендер, ~3500 строк)
  app.json                   манифест: сигналы, настройки, DID/масштабирование
  sim/*.png                  регенерируемые превью всех вкладок
kit/tools/                   тулчейн
  build.py                   apps/<id> -> dist/<id>@<ver>.mgu (tar.gz с бандлом)
  install.ps1                Windows: сборка + SSH-установка одной командой
  deploy.py                  Linux/macOS: SSH-деплой готового пакета
  emu.js                     live-превью в браузере (http://localhost:8077)
  simulate.js               генерация PNG-превью вкладок
  extract_sdk.js             извлечение oap-sdk из приложения-донора с HU
dist/                        готовые .mgu-пакеты
docs/                        инструкции (установка, получение SDK)
visuals/                     лого и промо-изображение
```

### Формат `.mgu`

`<app_id>@<version>.mgu` — это tar.gz ровно в том же формате, что прошивочные
`preinstalled_apps/*.tgz` на HU: в корне архива `app.json`, бандл лежит в
`javascript/app.js`, опционально `assets/*`.

---

## Разработка

### Сборка

```sh
python3 kit/tools/build.py m_vitals_plus
# -> dist/m_vitals_plus@0.1.0.mgu  (browserify подтянется автоматически в kit/tools/.node-deps)
```

### Локальный запуск без машины (эмулятор)

```sh
node kit/tools/emu.js m_vitals_plus
# открыть http://localhost:8077 — клики мыши пробрасываются в touch-обработчик HU:
# можно листать вкладки, нажимать START, OPEN/CLOSE клапаном
```

Эмулятор использует мок-ответы DME и real-time таймеры — интерфейс ведёт себя как
на машине. Превью вкладок для документации: `node kit/tools/simulate.js m_vitals_plus <вкладка>`.

### Деплой с Linux/macOS

```sh
python3 kit/tools/deploy.py m_vitals_plus --host 192.168.x.x [--key ~/.ssh/id_mgu]
```

### Настройки приложения (на машине, вкладка SETTINGS)

- **Boost from** — Auto / Sport display (FES) / Engine unit (DME по UDS);
- **Boost gauge max** — 1.5…3.5 bar;
- **Engine unit poll every** — 500…5000 мс;
- **Demo mode** — on/off/auto (на реальной машине поставьте **off**);
- **Язык / Language** — English / Русский;
- единицы температур (°C/°F) и скорости (km/h/mph), показ единиц на плитках;
- интервал сброса пиков (30 с…60 с).

---

## Установка и проверка на машине

Полный документ — [docs/INSTALL-ON-CAR.md](docs/INSTALL-ON-CAR.md): три способа
установки (PowerShell-скрипт / MGU Store / вручную по SSH), чек-лист первого
запуска и разбор частых проблем (`--` на плитках, несовпадение DID, права, откат).

Коротко:

1. Подключиться к HU по enet, зажигание включено.
2. `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/daniloz095/VMG-Utility/main/kit/tools/install.ps1))) -HostName 172.16.0.1`
3. Открыть приложение в меню OAP, проверить вкладки; при `demo=off` плитки без
   данных означают, что кандидат DID не подтвердился — сырые значения в логе
   помогут подобрать верный DID/масштаб в `app.json`.

---

## Публикация релизов

Готовый `.mgu` собирается автоматически (GitHub Actions, `.github/workflows/build.yml`)
и прикрепляется к релизу при создании тега `v*`:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Workflow соберёт `dist/m_vitals_plus@0.1.0.mgu` (Node + browserify; SDK не нужен —
модули HU подхватываются на машине) и создаст release с этим артефактом. После этого
однострочник из «Быстрый старт» ставит именно эту версию. Сборка также запускается
на каждый push в `main` (без создания релиза, артефакт доступен во вкладке Actions).

Удаление:

```powershell
ssh -i C:\Users\dmpol\.ssh\mgu_root_key root@172.16.0.1 "rm -rf /var/opt/private/oap/m_vitals_plus; killall oap-mainapp"
```

---

## Правовая информация

`oap-sdk` и файлы `.mgu` содержат проприетарный код BMW — **не коммитить,
не публиковать**, использовать только для собственной машины. Репозиторий этого
кода не содержит; он извлекается с вашей HU инструментом `extract_sdk.js`
(см. [docs/OAP-SDK.md](docs/OAP-SDK.md)).

Использование приложения и модификация данных автомобиля — на ваш страх и риск;
некоторые функции (управление клапаном выхлопа и т. п.) активны только с
парковочным тормозом и при зажигании.
