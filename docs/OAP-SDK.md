# Как получить oap-sdk с вашей головной части (MGU / iDrive 7)

BMW SDK (`oap-sdk`) — это код BMW, защищённый авторским правом, поэтому его нет ни в одном
репозитории. Он лежит внутри каждого «официального» онлайн-приложения на самой головной части.
Достать его можно за минуту: копируем прошивочное приложение `x_call`, извлекаем SDK инструментом
`kit/tools/extract_sdk.js`.

## Шаг 1. Скопировать приложение-донор с HU

На машине: зажигание включено, автомобиль припаркован. С вашего ПК:

```sh
# Linux / macOS / WSL
scp root@<IP-головки>:'/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz' .
mkdir x_call && tar xzf x_call@*.tgz -C x_call
```

Windows (PowerShell — `scp` и `tar` встроены):

```powershell
scp "root@<IP>:/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz" .
mkdir x_call
tar -xzf (Get-ChildItem x_call@*.tgz).Name -C x_call
```

Если по этому пути нет `x_call` (прошивка может отличаться), посмотрите, что есть:

```sh
ssh root@<IP> 'ls /usr/lib/oap-mainapp/preinstalled_apps/'
```

Есть вариант посвежее — приложения, которые машина скачала сама; их SDK новее (27.x):

```sh
scp root@<IP>:/var/opt/public/oap/oap_12204/source/javascript/app.js ./app.js
```

Примечание: SDK 27.x не содержит модулей `telephony`, `appstart`, `map`, `poi` — наши приложения
их не используют, так что подходит и он. Прошивочный `x_call` несёт SDK 24.10.x с полным публичным
API — это предпочтительный донор.

## Шаг 2. Извлечь SDK

```sh
node kit/tools/extract_sdk.js x_call/javascript/app.js     # пишет ./oap-sdk/
```

Результат:

| Путь | Что это |
|---|---|
| `oap-sdk/index.js`, `package.json` | рантайм, который сборка вендорит в каждое приложение (`require('oap-sdk')`) |
| `oap-sdk/source/` | каждый модуль SDK отдельным читаемым файлом по его реальному пути (`source/src/core/OnlineApp.js`, ...) |

Инструмент выведет список отсутствующих модулей, если донор был с урезанным SDK.

## Шаг 3. Никогда не коммитить SDK

Папка `oap-sdk/` должна быть в `.gitignore` (в этом репозитории — есть). Готовые `.mgu`-пакеты
тоже содержат код BMW: храните их для своей машины, но нигде не публикуйте.

## Дальше

```sh
python3 kit/tools/build.py m_vitals_plus   # сборка -> dist/m_vitals_plus@<ver>.mgu
node kit/tools/emu.js m_vitals_plus        # живой эмулятор на http://localhost:8077 (без машины)
deploy/make-car-kit.sh m_vitals_plus       # пакет для установки на машину
HU=root@<IP> KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```
