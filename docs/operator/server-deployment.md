# 단일 서버 배포

이 문서는 빈 Linux 서버 한 대에 설치하고 첫 세션, 백업, 재부팅, 업그레이드와 롤백까지 확인하는 **상위 순서표**다. 실제 명령과 실패 복구는 [test-ops 운영 runbook](test-ops.md), [백업과 복원](backup-restore.md), 운영 참고([실행 기반](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/execution/), [API 서버](api-server.md), [이미지와 공급망](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/), [설정 레퍼런스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/configuration/)), [quickstart](../quickstart.md), [실제 Claude로 확인하기](../real-claude.md)의 해당 절을 정본으로 삼는다. 이 문서와 정본이 다르면 정본을 따른다.

**현재 상태:** 공식 릴리스가 아직 없다. `v*` 릴리스는 없고, npm의 `@werft-ai/sdk`는 게시돼 있다. 앱 이미지는 `main` 머지마다 [`main-<12>` 태그로 게시](test-ops.md#게시된-이미지를-쓸-때)되므로 그 digest로 설치한다. 게시본을 쓸 수 없으면 저장소 checkout에서 [세 이미지를 직접 빌드](test-ops.md#이미지를-직접-빌드한다)한다.

## 배포 결정

- 대상은 단일 서버, `local-docker` 실행 기반이다. 이 설치에서 HA는 범위 밖이다. Helm chart로 Kubernetes에 올리는 절차(설치 순서, AWS values, 업그레이드·롤백, health 확인)는 [kubernetes-deployment.md](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-deployment/)에 있다.
- provider key는 운영자 key 하나를 공유한다. 사용자별 API key의 owner가 세션 owner이며, 사용자마다 별도 owner와 API key를 발급한다.
- object store는 전용 AWS S3 bucket이다. 같은 호스트의 LocalStack은 재부팅 때 object를 잃으므로 실서버의 지속성 근거로 쓰지 않는다.
- 기본 접근은 loopback bind와 SSH tunnel이다. reverse proxy는 TLS와 VPN 또는 IP allowlist가 모두 준비된 때만 선택한다.

## 1. 호스트를 준비한다

다음 항목이 모두 준비되기 전에는 release나 secret을 서버에 옮기지 않는다. 제품이 강제하는 버전과 quota 조건은 [test-ops의 호스트 요구 사항](test-ops.md#호스트-요구-사항)을 따른다.

- [ ] 지원되는 Linux와 CPU architecture다.
- [ ] Docker Engine 28 이상, Docker Compose 2.24.6 이상이다.
- [ ] Docker data root가 XFS `prjquota`로 mount됐고 용량과 inode에 20% 이상 여유가 있다.
- [ ] NTP가 동기화됐고 시간 동기화 실패를 감지할 수 있다.
- [ ] Docker 서비스가 호스트 재부팅 뒤 자동으로 시작하도록 설정됐다.
- [ ] 방화벽은 SSH와 선택한 TLS endpoint만 허용한다. API, PostgreSQL 포트와 Docker socket은 인터넷에 열지 않는다.
- [ ] `git`, `jq`, `curl`, Bun 1.3.14가 있고 checkout에서 dependency 설치를 마칠 수 있다.
- [ ] 호스트가 `ghcr.io`의 게시된 이미지를 받을 수 있다. 직접 빌드한다면 이미지를 둘 registry가 있고 호스트가 거기서 받을 수 있다. registry에 token이 필요하면 최소 권한으로 만들어 `docker login`에 stdin으로 전달하고 명령 인자, shell history, 로그에 값을 남기지 않는다.

Docker socket은 scheduler 컨테이너가 worker를 관리할 때만 read/write로 사용한다. 호스트 TCP socket을 켜거나 reverse proxy로 전달하지 않는다.

## 2. 네트워크 경로를 고정한다

### 기본: SSH tunnel

[test-ops의 접근 절차](test-ops.md#접근)대로 API는 `127.0.0.1`에 둔다. 각 사용자는 SSH tunnel을 열고 자신의 로컬 loopback으로 접속한다. PostgreSQL은 운영자가 서버 안에서만 접근한다.

### 선택: Nginx + TLS + allowlist 또는 VPN

API만 내부 DNS 이름으로 내보내고 upstream은 계속 loopback을 사용한다. 다음은 필요한 성질을 보여 주는 예시이며, 인증서 경로와 VPN 대역은 실제 값으로 바꾼다.

```nginx
server {
    listen 443 ssl;
    server_name werft.internal.example;

    ssl_certificate /etc/ssl/werft/fullchain.pem;
    ssl_certificate_key /etc/ssl/werft/privkey.pem;

    allow 10.8.0.0/24;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

같은 서버에서 시험 요청을 보내려면 `deny all;` 앞에 `allow 127.0.0.1;`을 더한다. 사설 CA를 쓰면 클라이언트가 그 CA를 믿어야 한다. `curl`은 `--cacert`로 CA 인증서를 넘기고 `-k`는 쓰지 않으며, 믿지 않는 브라우저는 `NET::ERR_CERT_AUTHORITY_INVALID`로 막힌다. 단일 서버에서 이 구성을 확인한 범위는 공개 문서 "단일 서버"의 "접근 경로"에 있다.

SSE는 연결을 오래 유지하므로 buffering을 끄고 read timeout을 짧게 두지 않는다. 어떤 경로를 택해도 PostgreSQL과 Docker socket은 proxy 또는 방화벽에 노출하지 않는다.

## 3. 전용 S3를 준비한다

[test-ops의 AWS 준비](test-ops.md#aws-준비s3에서만)를 그대로 따른다. 이 작업은 실제 AWS 권한과 비용이 생기므로 배포 담당자가 서버 배포 창에서 수행한다.

- [ ] 이 설치 전용 bucket 하나이며 region은 `ap-northeast-1`이다.
- [ ] versioning과 Object Lock이 켜져 있고 기본 retention은 없다.
- [ ] 기본 암호화는 SSE-S3 `AES256`이고 public access는 차단됐다.
- [ ] API와 복원 훈련에 필요한 최소 IAM만 부여됐다. bucket 생성 권한은 runtime 자격 증명에 없다.
- [ ] object version을 만료시키는 lifecycle rule을 두지 않는다. 기존 조직 정책이 있다면 이 bucket 또는 checkpoint prefix가 제외됐다는 증거를 남긴다.
- [ ] `TEST_OPS_OBJECT_STORE=s3` preflight가 create-only upload, legal hold, version read, hold 해제와 scratch version 삭제 왕복을 통과했다.

legal hold된 version을 lifecycle이나 수동 정리 대상으로 삼지 않는다. checkpoint 정리는 제품의 checkpoint GC가 version id와 hold 상태를 확인하며 수행한다.

## 4. release와 설정을 봉인한다

1. 배포할 `source_commit`을 정하고, 그 commit의 [게시된 이미지 digest](test-ops.md#게시된-이미지를-쓸-때)를 읽는다. 게시본을 쓸 수 없으면 그 checkout에서 [세 이미지를 직접 빌드](test-ops.md#이미지를-직접-빌드한다)해 registry에 올린 뒤 digest를 확인한다. 태그를 달 필요는 없다. `v*` 태그로 이미지를 게시하는 일은 [저장소 관리자의 절차](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/#저장소-관리자-v-태그로-게시)이고, 아직 게시된 릴리스는 없다.
2. [release manifest](test-ops.md#release-manifest)에 `source_commit`, control-host·worker·egress-proxy digest, `settings_digest`를 기록한다. tag만 적지 않는다.
3. `/etc/werft` 아래에 [env 파일](test-ops.md#env-파일)과 [설정 문서](test-ops.md#카탈로그)를 만들고 요구된 mode를 적용한다. env 파일의 `BOOTSTRAP_TOKEN`(32~256자 무작위 값)은 비워 둘 수 있다. 넣지 않으면 API가 토큰을 만들어 owner 전용 파일에 두고, 배포 뒤 `scripts/test-ops.sh bootstrap-token`이 한 번 보여 준다(로그에는 나오지 않는다). env 파일은 `0600`, 상태 디렉터리는 `0700`, 비밀이 없는 설정 문서는 migrate 컨테이너가 읽을 수 있는 `0644`를 사용한다.
4. provider key, S3 key, PostgreSQL password, egress token, bootstrap token, registry token을 shell history, PR, evidence 파일, 터미널 캡처와 로그에 넣지 않는다. secret 값은 저장소 밖 env 또는 각 도구의 credential store로만 전달한다.
5. release manifest를 배포 증거 디렉터리에 복사한다. env 파일과 credential은 복사하지 않는다.

## 5. 설치하고 첫 사용을 확인한다

[test-ops 배포](test-ops.md#배포)의 순서를 바꾸지 않는다.

1. release의 `source_commit`을 checkout하고 dependency를 고정 설치한다.
2. S3 object store로 `preflight`를 먼저 실행한다. 실패하면 `deploy`하지 않는다.
3. 같은 manifest로 `deploy`하고 `/readyz`, scheduler와 reconciler health를 [감시 지점](test-ops.md#감시-지점)에서 확인한다. 사용자가 접속할 endpoint의 인증 없는 `/docs`와 같은 origin의 `/docs/scalar.js`가 각각 HTML·JavaScript로 200을 응답하는지도 확인한다. 이 화면의 요청 시험 기능은 꺼져 있으므로 실제 API 호출은 다음 단계에서 발급한 key로 별도 수행한다.
4. [카탈로그](test-ops.md#카탈로그)에 적을 GitHub 저장소를 준비한다.
5. [첫 owner 절차](test-ops.md#첫-owner)대로 웹 콘솔 `/bootstrap`에서 env 파일의 `BOOTSTRAP_TOKEN`(없으면 `scripts/test-ops.sh bootstrap-token`의 출력)으로 첫 owner와 workspace를 만들고 `/login`으로 로그인한다. 같은 토큰을 다시 보내면 `409 BOOTSTRAP_DONE`인지 확인한다. 토큰과 비밀번호는 evidence에 남기지 않고 응답 코드만 적는다. `bootstrap-token`을 한 번 더 실행하면 토큰 없이 exit 1이어야 하고, `docker logs werft-test-ops-api-1 2>&1 | grep -c '^BOOTSTRAP_TOKEN='`는 `0`이어야 한다.
6. [API key 발급 절차](test-ops.md#api-key-발급과-폐기)로 첫 사용자의 owner와 key를 만든다. 평문 key는 한 번만 직접 전달하고 evidence에는 key id만 남긴다.
7. [quickstart의 curl 준비](../quickstart.md#2-curl-준비)를 API key와 서버 endpoint에 맞춘다. 로컬 스택 기동·초기화 명령과 `GATE-SPEC` 대본은 실행하지 않고, `body`의 `agent_release_id`는 배포한 설치에서 실제 연결로 만든 release id를 쓴다.
8. [실제 Claude 직접 대화](../real-claude.md#b-실제-claude와-직접-대화하기)의 첫 요청처럼 파일 작성·README 수정·commit을 명시한 자연어 작업으로 세션 하나를 만든다. 들어오는 permission 요청을 허용하고 세션이 `idle`이 될 때까지 기다린 뒤 turn 1이 `completed`인지와 SSE에 남은 `git commit` 실행 결과를 확인한다. worker는 push하지 않으므로 commit은 4단계의 sample repository에 올라가지 않고 worker의 작업 트리와 checkpoint에만 있다([실제 Claude 직접 대화](../real-claude.md#b-실제-claude와-직접-대화하기)의 커밋 작성자 설명). 아래 명령은 turn 1에서 `git commit`을 실행한 `tool_use`의 짝인 `tool_result`만 뽑는다. `is_error`가 `false`이고 `content`가 `[<branch> <hash>] <message>`로 시작하면 commit이 만들어진 것이다. 결과가 비어 있으면 Claude가 commit하지 않은 것이므로 실패로 판정한다. `curl: (28)`은 [quickstart ②](../quickstart.md#-이벤트-관찰)와 같이 정상이다.

   ```sh
   curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
     >/tmp/first-session-events.txt || true
   sed -n 's/^data: *//p' /tmp/first-session-events.txt |
     jq -s -c '[.[] | select(.turn_id == "1")] as $t
       | [$t[] | .data.message.content[]? | select(.type == "tool_use" and ((.input.command // "") | test("git .*commit"))) | .id] as $ids
       | $t[] | .data | select(.type == "tool_result" and (.tool_use_id as $u | $ids | index($u))) | {is_error, content}'
   ```

9. 그 세션을 pause하고 checkpoint revision이 생긴 뒤 resume하여 admission state가 `active`가 되는 데까지만 확인한다. 첫 사용 smoke에서는 추가 메시지를 보내지 않아 실제 provider turn을 하나로 제한한다. 성공 판정은 응답 문장이 아니라 API·turn·admission 상태, 8단계의 `git commit` `tool_result`, checkpoint revision으로 한다. pause가 끝난 뒤 `checkpoint_revision`이 `null`이 아니면 그 commit을 담은 작업 트리가 checkpoint에 저장된 것이다.
10. 세션 usage와 Anthropic Console의 실제 비용을 함께 기록한다. key 취급과 비용 판정 기준은 [실제 Claude 확인 문서](../real-claude.md#key-입력과-폐기)와 [비용 절](../real-claude.md#비용)을 따른다. 이 서버에서는 그 문서의 로컬 `local.sh` 명령을 실행하지 않는다.

owner 모델은 **API-key owner**다. 같은 provider key를 쓰더라도 사용자마다 다른 owner/API key를 발급하며, 한 사용자의 key를 다른 사용자에게 공유하지 않는다.

## 6. 백업과 복원 기준을 운영한다

[test-ops 백업](test-ops.md#백업)과 [백업 번들의 형식·검증](backup-restore.md)을 정본으로 사용한다.

- 일정: 매일 사용이 적은 시간, 그리고 모든 업그레이드 직전에 백업한다.
- 보존: 호스트에는 최근 14일 성공본, 암호화한 off-host 보관소에는 최근 90일 성공본을 둔다. `.partial`과 `.failed`는 성공본으로 세지 않는다.
- 복제: 성공본만 checksum과 함께 off-host로 복제한다. DB와 API key hash가 들어 있으므로 전송·보관 암호화와 최소 접근 권한을 적용한다.
- 알림: 명령의 non-zero exit, 서비스를 다시 열지 못한 경우, 26시간 동안 새 성공본이 없는 경우를 실패로 경보한다.
- 복원 훈련: 한 달에 한 번, 그리고 업그레이드 뒤 첫 백업마다 [restore drill](test-ops.md#복원-훈련)을 `--keep`으로 실행한다. 출력된 drill project, 검증 로그와 loopback 포트를 기록하고 검사한 뒤, 출력된 명령으로 그 project만 지운다. S3 drill bucket은 같은 정본 절의 마지막 문단대로 legal hold, object version과 delete marker를 정리한 뒤 삭제한다.

`restore-drill`은 postgres·object store까지만 복원하고 API endpoint를 띄우지 않으므로, 이 결과를 세션 연속성 증거로 쓰지 않는다. [실스택에서 복원 뒤 재개 확인](backup-restore.md#실스택에서-복원-뒤-재개-확인)은 synthetic project와 fake provider를 쓰는 제품 검증이며, 실운영 backup·provider transcript·paused 세션의 복구 증거가 아니다. 현재 도구만으로 그 실운영 연속성을 안전하게 검사할 수 없으므로 배포 증거에는 `UNVERIFIED`와 도구 공백을 기록하고, 별도 절차가 마련되기 전까지 복원 훈련을 `partial`로 판정한다.

## 7. 업그레이드와 롤백을 연습한다

[test-ops 업그레이드](test-ops.md#업그레이드)를 그대로 따른다.

1. 업그레이드 직전 성공 백업과 off-host 복제를 확인한다.
2. 새 manifest로 preflight를 실행한다.
3. worker image가 바뀌면 자동 restore-plan gate가 내놓은 영향 세션을 확인한다. 불완전하거나 혼합된 판정은 fail-closed이며 우회하지 않는다.
4. 승인 없이 호환 세션만 이어지는 경우 또는 정확한 영향 목록을 승인한 경우에만 upgrade한다.
5. first session smoke와 `status`를 다시 확인한다.

롤백은 이전 release manifest를 `upgrade`에 다시 적용하는 작업이다. 이전 worker로 돌아갈 때도 같은 호환성 gate와 백업 조건을 적용한다. `start_fresh`는 checkpoint context를 버리므로 단순 롤백 수단으로 쓰지 않는다.

## 8. 물리 재부팅을 확인한다

사용자에게 점검 시간을 알리고 진행한다.

### 재부팅 전

- [ ] 진행 중인 turn이 없고 첫 세션이 pause되어 checkpoint revision을 가진다.
- [ ] `status`가 정상이고 최근 백업과 off-host 복제가 성공했다.
- [ ] `backup --stop`으로 새 백업을 만든 뒤 writer가 멈춘 상태임을 확인한다.
- [ ] release manifest, backup 경로, 세션 id와 checkpoint revision을 evidence에 적는다. credential은 적지 않는다.

### 재부팅 뒤

- [ ] NTP, XFS `prjquota`, Docker 자동 기동, 디스크·inode 여유를 다시 확인한다.
- [ ] S3 설치의 [재시작 절차](test-ops.md#s3)로 `scripts/test-ops.sh start`를 불러 현재 release를 다시 띄운다.
- [ ] `status`, `/readyz`, scheduler, reconciler가 정상이다.
- [ ] 재부팅 전 세션을 resume하고 새 worker가 이전 workspace를 이어 가는지 확인한다.
- [ ] API는 선택한 내부 경로에서만 접근되고 PostgreSQL·Docker socket은 외부에서 닫혀 있다.

## 9. Day 1을 운영한다

- [ ] 시작, 1시간 뒤, 업무 종료 전에 `scripts/test-ops.sh status` 결과를 확인한다.
- [ ] API·scheduler·reconciler 구조화 로그와 디스크·inode·quota를 확인한다.
- [ ] [Datadog 모니터링 지침](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/monitoring-datadog/)의 readyz, Docker 로그, host/disk monitor를 적용한다. 그 문서가 아직 배포 release에 없다면 [test-ops 감시 지점](test-ops.md#감시-지점)을 임시 기준으로 사용하고 미적용 사실을 evidence에 적는다.
- [ ] backup 자동 실행과 실패 알림을 시험하되 운영 backup을 삭제하지 않는다.
- [ ] 사용자별 API key 전달과 폐기 연락 경로를 확인한다.
- [ ] provider usage와 실제 비용을 확인하고 세션 상한과 Anthropic 월 상한을 기록한다.

## 10. 증거를 남긴다

서버 배포 증거는 저장소나 PR이 아니라 서버의 다음 디렉터리에 둔다.

```text
/var/lib/werft/test-ops/evidence/<UTC timestamp>/
```

운영자만 읽을 수 있게 하고 off-host 보관소에 암호화해 복제한다. 최소한 다음을 남긴다.

| 파일 | 내용 |
|---|---|
| `release.json` | 배포한 manifest와 source commit, image digest, `settings_digest` |
| `preflight.txt` | S3 왕복을 포함한 성공 출력. credential과 scratch object 내용은 제거 |
| `status.txt` | 배포 직후와 Day 1의 readyz·scheduler·reconciler·disk 상태 |
| `first-session.md` | owner/key id, session id, turn 상태, SSE·승인·checkpoint·resume 판정. 평문 key 제외 |
| `provider.md` | provider 호출 시각, usage, 플랫폼 추정 비용, Console 실제 비용 |
| `backup-restore.md` | backup 경로·checksum, off-host 복제, restore drill과 세션 연속성 판정 |
| `reboot.md` | 재부팅 전후 상태와 같은 세션의 resume 결과 |
| `monitoring.md` | 적용한 monitor, alert 전달 시험, 알려진 계측 공백 |

실제 AWS·DNS·provider 작업을 하지 않은 항목은 `UNVERIFIED`로 남긴다. CI, 문서 검토, preflight, 실제 서버 동작, 비용 확인은 서로 다른 증거로 기록한다.
