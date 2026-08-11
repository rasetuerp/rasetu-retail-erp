# Refresh Diagnostics

RaSetu records every title-bar Refresh App click locally so support can separate normal user refreshes from freeze-recovery refreshes.

Log file on customer PC:

`%APPDATA%\rasetu-retail-erp\diagnostics\refresh-events.jsonl`

Each line is JSON with timestamp, app version, route, backend status, and whether the refresh was marked as suspected freeze. For support, ask the customer to send this file together with `main.log` from the same app data folder.

