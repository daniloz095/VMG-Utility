# Установка M Vitals+ через PowerShell

Одна команда в PowerShell на ноутбуке с Windows — приложение скачивается из
GitHub Releases и ставится на головное устройство (HU) по SSH. Python, Node.js
или репозиторий на ноутбуке **не нужны**.

---

## Что понадобится

| Компонент | Зачем |
|---|---|
| Windows 10/11 | хост для скрипта |
| ENET-кабель (OBD → Ethernet) **или** Wi-Fi-хотспот машины | связь с HU |
| root SSH-доступ и приватный ключ root | установка |
| «Клиент OpenSSH» (ssh/scp) — встроен в Windows 10+ | SSH/SCP |

---

## Шаг 1. Проверить окружение

```powershell
Get-Command ssh, scp, tar            # должны найтись все три
Test-Path "$env:USERPROFILE\.ssh\mgu_root_key"   # True, если ключ на месте
```

Если `ssh` не найден: **Параметры → Приложения → Дополнительные компоненты →
«Клиент OpenSSH» → Установить**, затем перезапустить PowerShell.

---

## Шаг 2. Подключить ноутбук и включить зажигание

- **ENET**: кабель в OBD-порт машины, Ethernet — в ноутбук. HU обычно на `172.16.0.1`.
- **Wi-Fi**: подключиться к хотспоту машины (по умолчанию `172.16.222.97`).
- Включить зажигание (или «разбудить» машину), чтобы HU отвечал по SSH.

Проверка связи:

```powershell
ssh -i "$env:USERPROFILE\.ssh\mgu_root_key" root@172.16.0.1 "echo ok"
```

---

## Шаг 3. Установить одной командой

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/daniloz095/VMG-Utility/main/kit/tools/install.ps1))) -HostName 172.16.0.1
```

Скрипт делает:
1. Находит последний релиз и скачивает `m_vitals_plus@<версия>.mgu`.
2. Распаковывает пакет.
3. Подключается к HU по SSH.
4. Заливает в `/var/opt/private/oap/m_vitals_plus/` и ставит права.
5. Перезапускает `oap-mainapp`.

Через ~5–10 секунд приложение «M Vitals+» появится в меню OAP.

---

## Параметры

| Параметр | По умолчанию | Описание |
|---|---|---|
| `-HostName` | — (обязателен) | IP/адрес HU |
| `-KeyPath` | `<профиль>\.ssh\mgu_root_key` | приватный ключ root |
| `-User` | `root` | пользователь SSH |
| `-RemoteBase` | `/var/opt/private/oap` | каталог приложений на HU |
| `-Repo` | `daniloz095/VMG-Utility` | откуда качать релиз |
| `-Local` | — | взять пакет из `dist/` (без скачивания) |
| `-Build` | — | собрать из исходников (нужны Python 3 + Node.js) |
| `-NoRestart` | — | не перезапускать `oap-mainapp` |

Пример с нестандартным ключом и IP (Wi-Fi хотспот):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/daniloz095/VMG-Utility/main/kit/tools/install.ps1))) -HostName 172.16.222.97 -KeyPath "$HOME\.ssh\id_mgu"
```

---

## Установка из клона репозитория

```powershell
git clone https://github.com/daniloz095/VMG-Utility.git
cd VMG-Utility
.\kit\tools\install.ps1 -HostName 172.16.0.1
```

---

## Удаление

```powershell
ssh -i "$env:USERPROFILE\.ssh\mgu_root_key" root@172.16.0.1 "rm -rf /var/opt/private/oap/m_vitals_plus; killall oap-mainapp"
```

---

## Частые проблемы

| Симптом | Причина / решение |
|---|---|
| `Cannot SSH to …` | зажигание/питание HU, неверный IP или ключ — см. Шаг 2 |
| `No release found` / `has no … asset` | релиза ещё нет — создать: `git tag v0.1.0 && git push origin v0.1.0` (CI соберёт пакет) |
| `SSH key not found` | ключ не по тому пути — передайте `-KeyPath` |
| приложения нет в меню | `ssh root@<IP> 'ls /var/opt/private/oap/'`, затем `killall oap-mainapp` |
| плитки показывают `--` | DID ещё калибруются под конкретный двигатель — см. `docs/INSTALL-ON-CAR.md` |

После установки зайдите в приложение → **SETTINGS → Demo mode = `off`**, чтобы
видеть реальные данные, а не симуляцию.
