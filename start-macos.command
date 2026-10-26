#!/bin/bash
cd "$(dirname "$0")" || exit 1

bash scripts/bootstrap-unix.sh
status=$?
if [[ $status -ne 0 ]]; then
  echo
  read -r -p "启动失败，按回车关闭窗口 ..." _
fi
