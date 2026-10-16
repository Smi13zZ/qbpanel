#!/bin/sh
### qbpanel CGI gateway
###
### The fnOS desktop entry points at this script; it forwards the request to
### the loopback qbpanel service that cmd/main started. Keeping the hop on
### loopback means the panel works even when the service is bound to
### 127.0.0.1 only, and the browser never needs the downloader credentials.

set -u

PORT_FILE=""

if [ -n "${TRIM_PKGVAR:-}" ]; then
    PORT_FILE="${TRIM_PKGVAR}/runtime-ports.env"
elif [ -n "${cgiName:-}" ]; then
    PORT_FILE="/var/apps/${cgiName}/var/runtime-ports.env"
elif [ -n "${SCRIPT_FILENAME:-}" ]; then
    case "${SCRIPT_FILENAME}" in
        */target/ui/index.cgi)
            PORT_FILE="${SCRIPT_FILENAME%/target/ui/index.cgi}/var/runtime-ports.env"
            ;;
    esac
fi

if [ -n "${PORT_FILE}" ] && [ -r "${PORT_FILE}" ]; then
    . "${PORT_FILE}"
fi

TARGET_HOST="${ADMIN_TARGET_HOST:-127.0.0.1}"

if [ -n "${ADMIN_TARGET_PORT:-}" ]; then
    TARGET_PORT="${ADMIN_TARGET_PORT}"
elif [ -n "${BACKEND_PORT:-}" ]; then
    TARGET_PORT="${BACKEND_PORT}"
elif [ -n "${wizard_backend_port:-}" ]; then
    TARGET_PORT="${wizard_backend_port}"
else
    TARGET_PORT="8898"
fi

REQ_URI="${REQUEST_URI:-}"
URI_NO_QUERY="${REQ_URI%%\?*}"
QUERY_STRING="${QUERY_STRING:-}"

case "${URI_NO_QUERY}" in
    */index.cgi)
        printf "Status: 302 Found\r\n"
        printf "Location: %s/\r\n" "${URI_NO_QUERY}"
        printf "Content-Type: text/plain; charset=utf-8\r\n"
        printf "Cache-Control: no-store\r\n\r\n"
        exit 0
        ;;
esac

case "${URI_NO_QUERY}" in
    *index.cgi*) REL_PATH="${URI_NO_QUERY#*index.cgi}" ;;
    *)           REL_PATH="${URI_NO_QUERY}" ;;
esac

[ -n "${REL_PATH}" ] || REL_PATH="/"

case "${REL_PATH}" in
    *..*)
        printf "Status: 400 Bad Request\r\n"
        printf "Content-Type: text/plain; charset=utf-8\r\n\r\n"
        printf "Bad Request\n"
        exit 1
        ;;
esac

TARGET_URL="http://${TARGET_HOST}:${TARGET_PORT}${REL_PATH}"
if [ -n "${QUERY_STRING}" ]; then
    TARGET_URL="${TARGET_URL}?${QUERY_STRING}"
fi

HEADER_FILE=$(mktemp)
BODY_FILE=$(mktemp)
trap 'rm -f "${HEADER_FILE}" "${BODY_FILE}"' EXIT

set -- -s -D "${HEADER_FILE}" -o "${BODY_FILE}" -X "${REQUEST_METHOD:-GET}"

[ -n "${CONTENT_TYPE:-}" ]         && set -- "$@" -H "Content-Type: ${CONTENT_TYPE}"
[ -n "${HTTP_ACCEPT:-}" ]          && set -- "$@" -H "Accept: ${HTTP_ACCEPT}"
[ -n "${HTTP_ACCEPT_LANGUAGE:-}" ] && set -- "$@" -H "Accept-Language: ${HTTP_ACCEPT_LANGUAGE}"
[ -n "${HTTP_USER_AGENT:-}" ]      && set -- "$@" -H "User-Agent: ${HTTP_USER_AGENT}"
[ -n "${HTTP_ORIGIN:-}" ]          && set -- "$@" -H "Origin: ${HTTP_ORIGIN}"
[ -n "${HTTP_X_REQUESTED_WITH:-}" ] && set -- "$@" -H "X-Requested-With: ${HTTP_X_REQUESTED_WITH}"

case "${REQUEST_METHOD:-GET}" in
    POST|PUT|PATCH|DELETE)
        set -- "$@" --data-binary @-
        ;;
esac

curl "$@" "${TARGET_URL}" >/dev/null 2>&1
CURL_EXIT=$?

if [ "${CURL_EXIT}" -ne 0 ]; then
    printf "Status: 502 Bad Gateway\r\n"
    printf "Content-Type: text/plain; charset=utf-8\r\n"
    printf "Cache-Control: no-store\r\n\r\n"
    printf "连接 qBpanel 服务失败，可能是服务未启动，请在应用中心重启该应用。\n"
    exit 0
fi

STATUS_LINE=$(grep -i '^HTTP/' "${HEADER_FILE}" | tail -1 | tr -d '\r')
STATUS_CODE=$(printf '%s' "${STATUS_LINE}" | awk '{print $2}')
STATUS_TEXT=$(printf '%s' "${STATUS_LINE}" | awk '{$1=""; $2=""; sub(/^[ \t]+/, ""); print}')

if [ "${STATUS_CODE}" = "204" ]; then
    printf "Status: 204 No Content\r\n"
elif [ -n "${STATUS_CODE}" ] && [ "${STATUS_CODE}" != "200" ]; then
    printf "Status: %s %s\r\n" "${STATUS_CODE}" "${STATUS_TEXT}"
fi

CONTENT_TYPE_LINE=$(grep -i '^content-type:' "${HEADER_FILE}" | tail -1 | tr -d '\r')
if [ -n "${CONTENT_TYPE_LINE}" ]; then
    printf "%s\r\n" "${CONTENT_TYPE_LINE}"
else
    printf "Content-Type: application/octet-stream\r\n"
fi

printf "Cache-Control: no-store\r\n"
printf "\r\n"
cat "${BODY_FILE}"
