# test-ops 운영 runbook

test-ops는 여러 사람이 함께 쓰는 상시 설치다. Linux 호스트 한 대에서 compose로 돈다. checkpoint object는 기본으로 같은 호스트의 LocalStack에 두고, 설정 하나로 AWS S3(도쿄)로 바꾼다(아래 "object store"). 배포·업그레이드·키 발급·백업·복원 훈련·재시작 복구는 모두 `scripts/test-ops.sh` 하나로 한다. 이 문서는 운영자용 절차다. 각 구성 요소가 어떻게 동작하는지는 [docs 색인의 운영자 문서](../README.md#운영자), 백업 번들의 형식과 검사는 [backup-restore.md](backup-restore.md)를 본다.

Kubernetes 설치는 `scripts/test-ops.sh`를 쓰지 않는다. 같은 일을 하는 명령은 [kubernetes-deployment.md](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-deployment/)에 있다.

| test-ops | Kubernetes 설치 |
|---|---|
| env 파일 | Secret(또는 ExternalSecret)과 설치별 values 파일 |
| 설정 문서 | `bun run settings:k8s import --document -` |
| release manifest(digest) | values의 `images.*.digest` |
| `deploy`·`upgrade` | `helm upgrade --install`. migrate는 hook이 먼저 돌린다 |
| `key create`·`key revoke`, `grants.ts` | `bun run keys:k8s`·`grants:k8s` |
| `backup`·`restore-drill` | RDS 백업·스냅샷과 S3 version([backup-restore.md § Kubernetes 설치](backup-restore.md#kubernetes-설치)) |
| 재시작 복구 | Deployment가 다시 띄운다. 확인은 [health 확인](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-deployment/#health-확인) |

지키는 규칙은 다음과 같다.

- **포트는 loopback에만 연다.** compose는 포트를 모두 `127.0.0.1`에만 연다. 사람은 SSH 터널이나 VPN으로 들어온다.
- **설정은 저장소 밖 env 파일 하나에 둔다.** 스크립트는 그 파일을 `docker compose --env-file`로만 넘기고 셸에서 `source`하지 않는다. compose를 부를 때 호출 셸의 환경도 넘기지 않는다. 셸에 남은 `AWS_*` 같은 값이 env 파일보다 우선하는 일을 막기 위해서다.
- **release는 digest로 고정한다.** 이미지는 가변 tag로 부르지 않는다.

## object store

기본값은 LocalStack이라 AWS 계정이 없어도 된다. 배포할 때 `TEST_OPS_OBJECT_STORE`로 고른다.

| 값 | 저장소 | compose layer |
|---|---|---|
| `localstack`(기본) | 같은 호스트의 LocalStack. 로컬 스택과 같은 이미지·초기화 스크립트이고, bucket은 `claude-sessions`다 | `infra/compose.test-ops.localstack.yml` |
| `s3` | AWS S3 bucket. 아래 "AWS 준비"를 따른다 | `infra/compose.test-ops.s3.yml` |

`deploy`가 고른 값을 상태 디렉터리의 `installation` 파일에 적고, 그 뒤 명령은 이 값을 쓴다. 배포된 설치의 저장소를 바꾸는 것은 `reset` 뒤 새 `deploy`다. 세션은 옮겨지지 않는다.

### LocalStack의 한계

- **LocalStack은 S3를 메모리에만 둔다.** LocalStack 컨테이너나 Docker, 호스트가 재시작되면 checkpoint object가 모두 사라진다. DB는 volume에 있으므로 남는다.
- `upgrade`는 LocalStack의 최종 렌더링된 서비스 정의(이미지 digest, 환경 변수, 포트, `restart` 정책 등)가 그대로면 컨테이너를 다시 만들지 않아 object가 남는다. LocalStack만 띄워 같은 compose 파일로 `up -d`를 다시 불렀을 때 컨테이너 id가 같았고 object 2개가 그대로였다. 정의가 달라지면 compose가 컨테이너를 다시 만들어 object가 사라진다. 같은 실험에서 `restart: unless-stopped`만 더해도 다시 만들어지고 object가 0개가 됐다. 정의에 닿는 것은 새 release의 `source_commit`에서 바뀐 compose 파일뿐 아니라 env 파일의 `AWS_REGION`·AWS 자격 증명·`TEST_OPS_LOCALSTACK_PORT`도 있다. 업그레이드 전에 `git diff <배포한 commit> <새 source_commit> -- infra/compose.core.yml infra/compose.test-ops.yml infra/compose.localstack.yml infra/compose.test-ops.localstack.yml scripts/test-ops.sh`와 env 파일의 변경을 확인한다. 달라졌으면 "계획 재시작"처럼 백업한 뒤 `reseed`로 복구한다.
- 그러면 DB에는 미수거 checkpoint가 있는데 bucket에는 object version이 하나도 없는 상태가 된다. 이때 API가 기동을 거부한다(로그 `Checkpoint bucket claude-sessions holds no object version, …`). 로그의 `scripts/local.sh reset` 안내는 로컬 스택용이고, test-ops에서는 아래 "재시작"의 `reseed`나 `reset`으로 푼다.
- 복구할 수 있는 것은 마지막 백업까지다. 백업 뒤에 생긴 checkpoint가 있으면 `reseed`가 거부하므로 `reset`밖에 없다. 초기화하면 세션·checkpoint·API key가 모두 지워진다.
- 그래서 **장기 보관이 필요한 세션을 두지 않는다.** 사용자에게도 언제든 초기화될 수 있는 환경이라고 알린다.

## 호스트 요구 사항

| 항목 | 요구 | 확인 |
|---|---|---|
| OS | Linux(x86_64 또는 arm64). 게시 이미지는 `linux/amd64`와 `linux/arm64`를 담는다. Dockerfile도 두 아키텍처를 모두 빌드한다 | |
| Docker Engine | 28 이상. worker 네트워크가 `gateway_mode_ipv4=isolated`를 쓴다 | `preflight`가 거부한다 |
| docker compose | v2.24.6 이상. 복원 훈련의 overlay가 include 위에 얹힌다 | `preflight`가 거부한다 |
| 디스크 | Docker 데이터 루트가 xfs이고 `prjquota`로 마운트돼 있어야 한다. worker workspace volume에 용량·inode 상한을 건다 | scheduler가 기동할 때 quota probe를 돌린다. 실패하면 scheduler가 unhealthy가 되고 `deploy`·`upgrade`가 멈춘다 |
| 도구 | git, jq, curl, 그리고 checkout에서 `bun install --frozen-lockfile`을 마친 bun 1.3.14 | S3 검사와 백업은 호스트에서 checkout의 S3 어댑터로 한다 |
| checkout | 배포할 release의 `source_commit`에 있고 로컬 변경이 없는 이 저장소 | `preflight`가 거부한다 |

compose 파일(`infra/compose.core.yml` + `infra/compose.test-ops.yml` + object store layer)과 postgres 초기 SQL, LocalStack 초기화 스크립트를 checkout에서 읽으므로, 업그레이드 사이에는 checkout을 배포한 commit에 그대로 둔다.

### 디스크: xfs `prjquota`가 필수인 이유와 ext4 서버 준비

세션마다 workspace volume이 생기고 같은 디스크의 postgres, LocalStack, 다른 세션과 공간을 나눈다. 용량(`EXECUTION_WORKSPACE_QUOTA_MB`, 기본 4096MiB)과 inode(`EXECUTION_WORKSPACE_QUOTA_INODES`, 기본 1,000,000) 상한은 xfs project quota가 강제한다. `prjquota`가 없으면(ext4 포함) Docker가 `size` 옵션을 거절해 scheduler의 quota probe가 실패한다. `EXECUTION_WORKSPACE_QUOTA=off`는 `scripts/lib/test-ops.ts`의 렌더 검사가 거부하므로 이 설치에서는 쓰지 않는다. ext4를 허용하지 않고 xfs `prjquota`를 필수로 유지하기로 했다.

확인:

```bash
findmnt -no FSTYPE,OPTIONS -T "$(docker info -f '{{.DockerRootDir}}')"   # xfs, 옵션에 prjquota
P="quota-probe-$(date +%s)"; docker volume create --driver local --opt size=64m "$P" && docker volume rm "$P"
```

ext4 서버는 xfs 이미지 파일을 `/var/lib/docker`에 `loop,prjquota`로 mount한다. 아래는 한 줄로 이어져 있어 어느 단계든 실패하면 Docker 시작까지 가지 않는다. 기존 `/var/lib/docker`는 `.old`로 옮겼다가 mount 뒤 `rsync`로 되돌리고, 처음 쓰는 서버면 그 두 단계는 건너뛴다.

```bash
[ ! -e /var/lib/docker.old ] &&
sudo apt-get install -y xfsprogs rsync &&
sudo systemctl stop docker docker.socket &&
{ [ ! -e /var/lib/docker ] || sudo mv /var/lib/docker /var/lib/docker.old; } &&
sudo truncate -s 60G /var/lib/docker.xfs.img &&
sudo mkfs.xfs -q /var/lib/docker.xfs.img &&
sudo mkdir -p /var/lib/docker &&
echo '/var/lib/docker.xfs.img /var/lib/docker xfs loop,prjquota 0 0' | sudo tee -a /etc/fstab &&
sudo mount /var/lib/docker &&
mount | grep 'on /var/lib/docker .*prjquota' &&
{ [ ! -e /var/lib/docker.old ] || sudo rsync -aHAX /var/lib/docker.old/ /var/lib/docker/; } &&
sudo systemctl start docker
```

`/var/lib/docker.old`가 이미 있으면 첫 단계에서 멈추니 내용을 치운 뒤 다시 한다. 중간에 멈추면 Docker는 멈춘 채로 두고 원인을 고친다. 이미 옮겼다면 `/var/lib/docker.old`가 원본이다. 60G는 Docker 전체의 천장이고, sparse 파일은 줄어들지 않는다. CI의 `workspace-quota` job이 `truncate`·`mkfs.xfs`·`mount -o loop,prjquota`를 8G 이미지로 돌린다. `/etc/fstab` 줄과 `rsync` 이전은 실행해 보지 않았다(미검증).

Kubernetes 경로(chart)에는 이 조건이 없다. workspace는 세션마다 PVC이고 상한은 `worker.workspace.quotaMb`(기본 4096MiB) 요청이 전부다. 실제로 막는 것은 StorageClass이고 inode 상한은 없다. 표는 `apps/docs/content/docs/run-server/self-hosting/kubernetes.mdx`의 "workspace 저장소와 상한"에 있다.

checkout과 호스트 bun 없이 설치하려면 [릴리스 번들](#릴리스-번들로-설치)을 쓴다. 그 경우 위 "도구"와 "checkout" 줄은 아래 번들 표가 대신한다.

## 릴리스 번들로 설치

`v*` 릴리스의 GitHub Release에는 `release-manifest.json` 말고 `werft-test-ops-<tag>.tar.gz`와 `.sha256`이 붙는다. 번들은 compose 파일, `scripts/test-ops.sh`와 그 헬퍼, postgres 초기 SQL, LocalStack 초기화 스크립트, 예시 설정, 그 릴리스의 `release-manifest.json`을 checkout과 같은 배치로 담는다. 이미지는 담지 않는다. 이미지는 GHCR에 이미 게시된 digest 그대로 `deploy`가 받는다. 번들은 태그를 찍은 run에서만 만들어 올린다.

| | checkout 설치 | 번들 설치 |
|---|---|---|
| 필요한 것 | git, jq, curl, bun 1.3.14(`bun install` 완료), 배포 commit의 checkout | docker, jq, curl. git·bun·checkout 없음 |
| 헬퍼(`scripts/lib/test-ops.ts`) | 호스트 bun | 릴리스의 control-host 이미지(digest 고정)에서 실행. 첫 실행에 그 이미지를 받는다 |
| 진입점 | `scripts/test-ops.sh <동사>` | 번들을 푼 디렉터리의 `scripts/test-ops.sh <동사>` |
| 릴리스 확인 | git의 `HEAD`가 `source_commit`이고 로컬 변경 없음 | `SHA256SUMS`와 파일 목록이 맞고, manifest의 commit과 이미지 3개가 번들의 `release-manifest.json`과 같음 |
| `preflight` `deploy` `start` `stop` `status` `key` `reset` `manifest` | 지원 | 지원 |
| `upgrade` `backup` `reseed` `restore-drill` | 지원 | 거부. checkout에서 한다 |

`upgrade`·`backup`·`reseed`·`restore-drill`은 업그레이드 게이트와 복원 도구(`scripts/verify-restore.sh` 등)를 쓰므로 번들에 없다. 번들에서 이 동사를 부르면 거부하고 checkout 경로를 안내한다. 같은 env 파일과 상태 디렉터리를 쓰므로, 번들로 설치한 설치를 나중에 `git checkout <source_commit>` 한 저장소에서 이어서 다룰 수 있다. LocalStack 설치는 컨테이너가 내려가면 객체를 잃으므로(아래 `reseed`) 체크포인트가 쌓인 설치는 checkout 경로를 권한다.

```bash
TAG=v0.1.2   # 쓸 릴리스 태그
mkdir "$TAG" && cd "$TAG"
gh release download "$TAG" -R JeongJaeSoon/werft -p 'werft-test-ops-*' -p release-manifest.json
sha256sum -c "werft-test-ops-$TAG.tar.gz.sha256"
tar -xzf "werft-test-ops-$TAG.tar.gz" && cd "werft-test-ops-$TAG"
# env 파일(infra/test-ops.env.example)과 설정 문서를 준비한 뒤
scripts/test-ops.sh manifest release-manifest.json /etc/werft/settings.json > ../release.json
scripts/test-ops.sh preflight ../release.json
scripts/test-ops.sh deploy ../release.json
```

`sha256`은 내려받다 깨진 파일과 빠진 파일을 잡는다. 릴리스 출처를 증명하지는 않으므로, `gh release download`(GitHub, TLS)로 받은 파일만 쓴다. `manifest` 동사는 릴리스 manifest와 설정 문서의 sha256으로 `deploy`가 받는 manifest를 만든다. 번들의 `preflight`·`deploy`는 그 manifest의 이미지 3개와 commit이 번들 안 `release-manifest.json`과 다르면 거부한다.

## AWS 준비(`s3`에서만)

`TEST_OPS_OBJECT_STORE=s3`로 배포할 때만 필요하다.

### bucket

도쿄 리전(`ap-northeast-1`)에 bucket을 하나 만든다. 설정은 셋이다: versioning, Object Lock(기본 retention 없음), 기본 암호화 SSE-S3(`AES256`). checkpoint는 legal hold로만 보호한다. 기본 retention을 걸면 checkpoint GC와 preflight의 삭제가 실패한다.

```bash
bucket=werft-test-ops   # 전역에서 유일한 이름
aws s3api create-bucket --bucket "$bucket" --region ap-northeast-1 \
  --create-bucket-configuration LocationConstraint=ap-northeast-1 \
  --object-lock-enabled-for-bucket
aws s3api put-bucket-encryption --bucket "$bucket" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Object Lock을 켜면 versioning도 함께 켜진다.

### API용 IAM 사용자

자격 증명은 API와 maintenance 컨테이너에만 간다. worker는 egress proxy의 object store route를 지나며, 그 요청은 API가 세션 prefix 범위로 서명한다. 복원 훈련도 같은 자격 증명으로 훈련용 bucket에 쓰므로 `<bucket>-drill-*`까지 허용한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetEncryptionConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::werft-test-ops",
        "arn:aws:s3:::werft-test-ops-drill-*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectLegalHold",
        "s3:PutObjectLegalHold",
        "s3:DeleteObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::werft-test-ops/*",
        "arn:aws:s3:::werft-test-ops-drill-*/*"
      ]
    }
  ]
}
```

`If-None-Match` 조건부 쓰기에는 별도 action이 없다. checkpoint GC는 version id로 지우므로 `s3:DeleteObject`는 필요 없다. bucket 생성 권한은 주지 않는다. 훈련용 bucket은 운영자가 자기 AWS 권한으로 만든다.

## env 파일

`infra/test-ops.env.example`을 저장소 밖에 복사해 채운다. 파일은 운영자만 읽을 수 있어야 한다. group이나 other에 읽기·쓰기 권한이 있으면 스크립트가 거부한다.

```bash
sudo mkdir -p /etc/werft
sudo install -m 600 -o "$USER" infra/test-ops.env.example /etc/werft/test-ops.env
sudo install -d -m 700 -o "$USER" /var/lib/werft/test-ops   # TEST_OPS_STATE_DIR
```

`/etc/werft`은 root 소유라 파일은 제자리에 쓰는 편집기로 고친다. `sed -i`처럼 같은 디렉터리에 임시 파일을 만드는 도구는 `Permission denied`로 실패한다. 상태 디렉터리(아래 `TEST_OPS_STATE_DIR`)도 운영자가 쓸 수 있어야 한다. 스크립트는 sudo 없이 돌고, 없으면 `cannot create the state directory`로 멈춘다.

| 변수 | 값 |
|---|---|
| `EXECUTION_INSTALLATION_ID` | `test-ops`. scheduler가 띄운 worker 컨테이너와 egress proxy의 label이다. `local`(로컬 스택)이거나 이 daemon의 컨테이너가 이미 같은 값을 달고 있으면 `deploy`가 거부하고, 배포한 뒤에는 바꿀 수 없다 |
| `POSTGRES_PASSWORD` | 무작위 값. `DATABASE_URL`에 escape 없이 들어가므로 영문·숫자·`.` `_` `~` `-`만 쓴다. `preflight`가 다른 문자를 거부한다 |
| `EGRESS_AUTHORIZER_TOKEN` | 32자 이상 무작위 값. API와 egress proxy가 같은 값을 쓴다 |
| `ANTHROPIC_API_KEY` | 선택. 비워도 렌더되고 시작된다. 기본은 콘솔 모델 연결 화면에서 넣는다(아래 "provider key"). 연결이 `value_env: ANTHROPIC_API_KEY`로 이름을 가리킬 때만 채운다. API에만 간다 |
| `PLATFORM_SETTINGS_DOCUMENT` | 설정 문서 파일. 기본 예시는 `/etc/werft/settings.json`. checkout 안이면 거부한다 |
| `PLATFORM_SECRET_KEY` | 64자 hex(`openssl rand -hex 32`). 저장한 자격 증명을 봉인하는 master key다. API와 slack 역할에만 가고, 없으면 `preflight`가 거부한다. 잃으면 저장한 값을 읽지 못한다 |
| `EGRESS_CREDENTIAL_ALLOWLIST` | `localstack`: `api.anthropic.com:443,github.com:443`. `s3`: `api.anthropic.com:443,github.com:443,<bucket>.s3.ap-northeast-1.amazonaws.com:443`. `github.com:443`이 없으면 worker가 카탈로그의 GitHub 저장소를 clone하지 못한다. bucket 호스트가 없으면 worker가 checkpoint를 쓰지 못하므로 `preflight`가 거부한다. 이름에 `.`이 든 bucket은 `s3.ap-northeast-1.amazonaws.com:443`이다 |
| `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST` | `localstack`: `localstack:4566`. 없으면 worker가 checkpoint를 쓰지 못하므로 거부한다. `s3`: 비워 둔다. 어느 쪽이든 로컬 전용 서비스(`fake-messages`, `secrets`, `fake-git`, `s3`에서는 `localstack`도)를 적으면 거부한다 |
| `EXECUTION_WORKSPACE_QUOTA` | `on`. 다른 값이면 거부한다 |

`s3`에서만 다음을 더 채운다. `localstack`에서는 비워 둔다. API는 LocalStack의 `claude-sessions` bucket에 LocalStack용 고정 key로 붙고, `S3_BUCKET`을 다른 값으로 두면 `preflight`가 거부한다.

| 변수 | 값 |
|---|---|
| `AWS_REGION` | `ap-northeast-1` |
| `S3_BUCKET` | 위 bucket 이름 |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | 위 IAM 사용자의 key. API와 maintenance 컨테이너에만 간다 |

`BOOTSTRAP_TOKEN`은 요구하지 않는다. 웹 콘솔의 첫 owner를 만드는 토큰(32~256자 무작위 값)이고 API에만 간다. 넣지 않으면 API가 기동할 때 하나를 만들어 api 컨테이너의 `BOOTSTRAP_TOKEN_FILE`(compose.test-ops.yml이 정하는 `/tmp/werft-bootstrap-token`, 소유자만 읽는다)에 둔다. 로그에는 출력하지 않고, `scripts/test-ops.sh bootstrap-token`이 한 번 꺼내 보이면서 지운다. 쓰기에 실패하면 토큰을 만들었다는 한 줄만 남기고 값은 어디에도 출력하지 않으니, 그때는 `BOOTSTRAP_TOKEN`을 env 파일에 넣는다. 예시 파일처럼 줄을 주석으로 두면 이 자동 생성 경로를 쓴다. 주석을 풀고 값을 비우면 API가 기동하지 않는다. 첫 owner가 생긴 뒤에는 이 값이 다시 통과하지 않으므로 env 파일에 남겨 둬도 된다([API 서버](api-server.md#api-인증과-권한)의 웹 콘솔·계정 복구 문단).

`compose.test-ops.yml`과 `compose.test-ops.s3.yml`은 위 값을 `${X:?}`로 요구하기만 한다. 하나라도 비면 compose가 렌더를 거부하고 core의 로컬 기본값으로 뜨는 일이 없다. 설치 상한(`EXECUTION_SLOT_LIMIT`, `SESSION_COST_LIMIT_USD` 등)은 넣지 않으면 core 기본값을 쓴다.

호스트 포트가 이미 쓰이면 env 파일에 다음을 넣는다. 값을 주지 않으면 기본값을 쓴다. 어떤 값이든 `127.0.0.1`에만 열린다.

| 변수 | 기본값 | 값 |
|---|---|---|
| `TEST_OPS_API_PORT` | `3000` | API와 웹 콘솔의 호스트 포트. 1~65535 |
| `TEST_OPS_POSTGRES_PORT` | `5432` | postgres의 호스트 포트. 1~65535 |
| `TEST_OPS_LOCALSTACK_PORT` | `4566` | LocalStack의 호스트 포트. 1~65535. `localstack`에서만 쓰고 `s3`에서는 무시한다. API와 worker는 호스트 포트를 거치지 않으므로 `http://localstack:4566`과 `localstack:4566`은 그대로 둔다 |
| `TEST_OPS_API_URL` | `http://127.0.0.1:<TEST_OPS_API_PORT>` | `deploy`·`upgrade`·`status`가 `/readyz`를 확인하는 주소. 포트를 따라가므로 호스트 앞에 프록시를 둘 때만 그 호스트 이름으로 넣는다. `scheme://host[:port]` 형식이고 경로와 끝의 `/`는 쓰지 않는다 |

`preflight`는 범위 밖 포트, 두 서비스가 같은 포트를 쓰는 값, 형식이 틀린 URL, 게시한 API 포트와 다른 포트를 쓰는 IP 주소·`localhost` URL을 거부한다. 오류 문구에 포트와 URL 값은 넣지 않는다. 이미 배포한 설치의 포트를 바꾸려면 env 파일을 고치고 `scripts/test-ops.sh upgrade /var/lib/werft/test-ops/current.json`으로 같은 release를 다시 적용한다. 이 문서의 3000과 5432는 기본값이다. 값을 바꾸면 터널과 `curl` 명령의 포트도 함께 바꾼다.

콘솔에서 GitHub App을 새로 만들려면 env 파일에 `CONSOLE_ORIGIN=<브라우저가 콘솔을 여는 origin>`도 넣는다([api-server.md](api-server.md)의 env 표). 없으면 콘솔의 "GitHub에서 만들기" 버튼이 꺼진다. 예시 파일에는 이 줄이 없다. 단일 서버에서 SSH tunnel로 열면 `http://127.0.0.1:<터널 포트>`다. 바꾼 뒤에는 위와 같이 `upgrade`로 적용했고(api 컨테이너가 다시 만들어지고 `/readyz`가 ready), `start`가 새 값을 읽는지는 확인하지 못했다.

`TEST_OPS_LOCALSTACK_PORT`는 `upgrade`로 바꾸지 못한다. 포트가 바뀌면 compose가 LocalStack 컨테이너를 다시 만들어 object가 모두 사라지므로(위 "LocalStack의 한계") `preflight`가 실행 중인 포트와 다른 값을 거부한다. "계획 재시작"처럼 `scripts/test-ops.sh backup --stop`으로 백업하고, env 파일을 고치고, 그 백업으로 `reseed`를 부른다. `reseed`가 렌더를 검사한 뒤 LocalStack을 새 포트로 띄우고 object를 되살린다.

스크립트 자체의 설정은 셸 변수 넷이다. 기본값을 쓰면 아무것도 설정하지 않아도 된다.

| 변수 | 기본값 |
|---|---|
| `TEST_OPS_ENV_FILE` | `/etc/werft/test-ops.env` |
| `TEST_OPS_STATE_DIR` | `/var/lib/werft/test-ops`. 배포한 manifest(`current.json`), 이력(`history.log`), 업그레이드 승인, 백업, 복원 훈련 기록 |
| `TEST_OPS_PROJECT` | `werft-test-ops`. 로컬 스택의 `werft`이면 거부한다 |
| `TEST_OPS_OBJECT_STORE` | `localstack`. `deploy` 때만 읽는다. 그 뒤에 다른 값을 주면 거부한다 |

`deploy`는 project 이름, `EXECUTION_INSTALLATION_ID`, object store를 상태 디렉터리의 `installation` 파일에 적는다. 그 뒤의 명령은 하나라도 다르면 거부한다. `preflight`는 bucket을 건드리기 전에 이것부터 확인한다. 백업과 업그레이드가 멈추는 worker를 이 label로 찾기 때문이다. `deploy`·`upgrade`·`backup`·`restore-drill`·`reseed`·`reset`은 상태 디렉터리의 `lock`을 잡고 한 번에 하나만 돈다. 강제 종료된 실행이 lock을 남기면 그 pid가 없는 것을 확인하고 디렉터리를 지운다.

## 카탈로그

`PLATFORM_SETTINGS_DOCUMENT`에 설정 문서 하나를 둔다. migrate가 `deploy`·`upgrade`마다 이 문서를 가져온다. 가져오기는 더하기만 하므로 이미 있는 항목은 그대로이고, 같은 id를 다른 내용으로 고치면 migrate가 실패해 새 release가 뜨지 않는다. migrate 컨테이너(uid 1000)가 읽을 수 있게 파일은 `0644`로 둔다. 문서에는 값이 아니라 참조만 적으므로 비밀이 없다. 기본 안내는 문서에 연결을 적지 않고 콘솔에서 만드는 것이다. 문서에 적는다면 provider는 실제 Messages API로, key는 `value_env: ANTHROPIC_API_KEY`로 적고, 에이전트가 고를 모델을 `models`에 적는다. 그런 연결을 콘솔에서 키를 넣는 방식(stored)으로 옮기면(모델 연결 행의 "화면에서 키 넣기") 연결 행은 stored로 바뀌고 옛 참조는 `provider_connections.replaces_auth`에 남는다. 그 연결로 만든 release와 세션은 계속 돌고, 문서가 옛 항목을 그대로 적고 있어도 가져오기는 DB 행을 둔다(`kept`). 옮긴 뒤에는 `ANTHROPIC_API_KEY`가 그 연결에 쓰이지 않는다. 이 열은 추가형이라 앞 이미지로 되돌려도 무시되지만, 되돌린 이미지는 옮긴 연결의 stored 정의를 `stored` 참조로 읽을 뿐 옛 env 참조로 돌아가지 않는다.

```json
{
  "version": 1,
  "connections": {
    "anthropic": {
      "kind": "anthropic",
      "endpoint": "https://api.anthropic.com",
      "auth": { "kind": "api_key", "value_env": "ANTHROPIC_API_KEY" },
      "models": ["claude-sonnet-5"]
    }
  },
  "repositories": {
    "sample-app": {
      "url": "https://github.com/<owner>/<repo>.git",
      "branch": "main",
      "auth": { "kind": "github_app" }
    }
  },
  "mcp_servers": {}
}
```

test-ops에는 git 호스트가 없다. 저장소는 GitHub에 둔다. 저장소 항목에는 `"auth": {"kind": "github_app"}`가 꼭 있어야 한다. 없으면 가져오기가 그 저장소를 빼고 `note: repository <id> is not imported`만 남기며, 세션이 그 저장소를 쓸 수 없다. `preflight`가 문서를 JSON으로 읽어 `auth`가 없거나 `basic`·`bearer`인 저장소를 이미지를 올리기 전에 거부하므로(`preflight`·`deploy`·`upgrade` 모두), 컨테이너도 `pending.json`도 생기지 않고 기존 상태가 그대로다. 문서에 `"auth": {"kind": "github_app"}`를 넣고 다시 부른다. 문서가 바뀌면 digest가 바뀌므로 manifest의 `settings_digest`도 새 값으로 고친다. 이미 DB에 같은 id의 행이 있으면(이전 가져오기가 `auth` 없이 넣은 행) `auth`를 더해도 내용이 달라 `conflicts`로 거부된다. 그때는 문서에서 그 항목을 지우거나 새 id로 바꾼다. `pending.json`이 남아 멈추는 경로는 DB에 `auth` 없는 행이 있는데 `auth`를 더해 `conflicts`가 `pending.json` 뒤에 터진 경우다. 그 경로와 이 검사 전의 `upgrade`가 `settings_applied`에서 멈춘 이전 릴리스의 경우 모두 고친 manifest를 `pending.json`에 복사한 뒤 `upgrade <고친 manifest>`를 부른다(`cp <고친 manifest> <상태 디렉터리>/pending.json`). `current.json`이 없는 채로 첫 `deploy`가 앱을 띄운 뒤 멈춘 경우는 `deploy`·`upgrade`·`reset`이 모두 거부하므로, 이 설치에 세션이 없음을 확인하고 `docker compose --project-name <project> down -v`로 그 project를 지운 뒤 `deploy`를 다시 부른다. 첫 `deploy`가 빈 허용 저장소로 상한을 시드한 뒤에는 문서를 고쳐도 상한이 바뀌지 않으므로, 그 상한의 허용 저장소는 콘솔에서 새 버전으로 고친다. 저장소의 GitHub App 접근은 설치한 뒤 콘솔에서 등록하는 App으로 정해진다([api-server.md](api-server.md)).

release manifest에 적을 digest는 문서 파일 바이트의 sha256이다. 다음으로 구한다.

```bash
bun run scripts/lib/test-ops.ts settings-digest /etc/werft/settings.json
```

`preflight`는 마운트한 문서가 이 digest와 다르면 거부한다. `deploy`·`upgrade`는 끝에서 `settings import --dry-run`으로 DB가 문서를 모두 담았는지 보고, 더할 것이 남아 있으면 `the database does not hold the settings document`로 멈춘다. 문서의 digest가 그대로면 `upgrade`는 migrate를 다시 돌리지 않는다.

연결 설정은 DB 행이 정본이다. 모델 목록과 자동 모드 판정은 콘솔의 **모델 연결**에서 바꾸고, endpoint·자격 증명 출처를 바꿀 때는 새 id로 연결을 더한 뒤 에이전트를 다시 release한다([api-server.md](api-server.md#운영자-카탈로그-모델-연결--repository)).

**파일 카탈로그로 돌던 설치.** 올리기 전에 env 파일에서 `PLATFORM_CATALOG_DIR`을 지우고, 옛 디렉터리를 `PLATFORM_LEGACY_CONFIG_DIR`로 준다. migrate가 그 디렉터리를 한 번 가져온다. master key를 `PLATFORM_SECRET_KEY`로 옮기는 일까지 순서는 [api-server.md](api-server.md#설정-문서-가져오기내보내기)의 "파일 카탈로그에서 옮기기"를 따른다. 가져온 뒤 `settings export`의 결과를 설정 문서로 두면 다음 `upgrade`부터 옛 디렉터리가 필요 없다.

## release manifest

manifest는 JSON 파일 하나다. 예시는 `infra/test-ops.release.example.json`이다. 예시의 `ghcr.io` 이름은 형식을 보여 줄 뿐이고, 그 digest의 이미지는 없다.

| 필드 | 값 |
|---|---|
| `source_commit` | compose 파일을 읽을 commit, 40자 hex |
| `images.control_host`, `images.worker`, `images.egress_proxy` | `<이름>@sha256:<64자 hex>`. tag만 적은 이미지, 짧은 digest는 거부한다 |
| `settings_digest` | 위 `settings-digest`의 출력 |

### 이미지를 직접 빌드한다

[게시된 이미지](#게시된-이미지를-쓸-때)를 쓸 수 없을 때의 경로다(amd64·arm64가 아닌 호스트, 게시되지 않은 commit). `source_commit`의 checkout에서 세 이미지를 빌드해 호스트가 받을 수 있는 registry에 올리고, push가 돌려준 digest를 manifest에 적는다. 이미지는 빌드한 머신의 아키텍처로 만들어지므로 호스트와 같은 아키텍처에서 빌드한다. 인수 리허설은 호스트 loopback의 registry(`127.0.0.1:5000`)로 이렇게 했다.

```bash
R=<registry>   # 예: 127.0.0.1:5000
export API_IMAGE=$R/werft-control-host:rc WORKER_IMAGE=$R/werft-worker:rc \
  EGRESS_PROXY_IMAGE=$R/werft-egress-proxy:rc
docker compose -f infra/compose.yml --profile apps --profile worker build api worker egress-proxy
for i in "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE"; do
  docker push -q "$i" && docker inspect --format '{{index .RepoDigests 0}}' "$i"
done
unset API_IMAGE WORKER_IMAGE EGRESS_PROXY_IMAGE
```

### 게시된 이미지를 쓸 때

`main` 머지마다 Images workflow(`.github/workflows/images.yml`)가 세 이미지를 `ghcr.io/jeongjaesoon/werft-<app>:main-<12>`로 게시한다. `v*` 태그의 게시 절차가 성공하면 GitHub Release가 게시되고 `release-manifest.json`이 붙는다. 태그만 있고 Release가 없는 경우도 있다(`v0.1.1`). 최신 게시 릴리스는 `v0.1.2`다. 설치하는 운영자는 태그를 달지 않는다. 태그와 게시는 [저장소 관리자의 절차](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/#저장소-관리자-v-태그로-게시)다. 게시본은 `linux/amd64`와 `linux/arm64`를 담는 index다.

릴리스(`v*` 태그)를 쓸 때는 그 GitHub Release의 `release-manifest.json`에서 읽는다. 아래 명령이 이 문서의 manifest 이미지 줄과 `source_commit`을 채운다. `settings_digest`는 위 `settings-digest`의 출력을 더한다. 저장소 checkout은 필요 없다.

```bash
TAG=v0.1.2   # 쓸 릴리스 태그
gh release download "$TAG" -R JeongJaeSoon/werft -p release-manifest.json -D "$TAG"
jq '{source_commit: .commit, images: {
  control_host: (.images["control-host"] | "\(.image)@\(.digest)"),
  worker: (.images.worker | "\(.image)@\(.digest)"),
  egress_proxy: (.images["egress-proxy"] | "\(.image)@\(.digest)")}}' "$TAG/release-manifest.json"
```

릴리스가 없을 때(`main` 머지)는 [`main-<12>`를 읽는 명령](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/#main-머지마다-게시되는-이미지)이나 `docker buildx imagetools inspect ghcr.io/jeongjaesoon/werft-worker:<tag>`로 digest를 읽고, manifest에는 digest로 적는다. `staged-digests`와 `arch-digest-*` artifact는 promote를 거치지 않은 후보이므로 쓰지 않는다. registry가 비공개면 호스트에서 `docker login ghcr.io`를 먼저 한다.

## 배포

빈 호스트에서 한 번 한다.

```bash
git clone https://github.com/JeongJaeSoon/werft.git && cd werft
git checkout <source_commit>
bun install --frozen-lockfile
# env 파일, 설정 문서, manifest를 준비한 뒤
scripts/test-ops.sh preflight release.json   # 먼저 따로 돌려 봐도 된다
scripts/test-ops.sh deploy release.json      # LocalStack
# AWS S3로 배포할 때:
# TEST_OPS_OBJECT_STORE=s3 scripts/test-ops.sh deploy release.json
```

`deploy`는 이미 배포된 release(`current.json`)가 있거나 같은 project의 컨테이너·volume·network가 남아 있으면 거부한다. 먼저 `preflight`를 돈다. preflight가 보는 것은 다음과 같다.

1. env 파일 권한, manifest 형식, checkout의 commit과 로컬 변경
2. Docker Engine 28 이상, compose v2.24.6 이상
3. 렌더된 compose: 로컬 전용 서비스가 없고(`localstack`에서는 LocalStack 하나만 허용), 무엇도 build하지 않고, 모든 이미지가 digest이고, 포트가 loopback이고 서비스마다 겹치지 않는 포트 하나이고, API 확인 주소가 게시한 포트와 맞고, API가 `api-key` 인증과 `locked` object store로 뜨고, postgres 값이 URL-safe이고, API가 고른 저장소를 가리키고(`localstack`: `http://localstack:4566`과 `claude-sessions`, `s3`: endpoint 없음), credential allowlist에 그 저장소가 있고 다른 로컬 서비스가 없고, workspace quota가 켜져 있고, 설정 문서가 checkout 밖에서 migrate에 mount되고 manifest의 `settings_digest`와 같은지
4. `s3`에서만. bucket: API가 기동할 때 하는 검사(versioning, Object Lock, `AES256`)
5. `s3`에서만. API 자격 증명의 임시 객체 왕복: `test-ops-preflight/` 아래 scratch key에 create-only put(If-None-Match) → legal hold → hold 확인과 version 읽기 → hold 해제 → version 삭제. 실패하면 그 단계의 S3 action 이름을 출력한다. API의 기동 검사는 bucket 설정만 읽으므로 쓰기·hold·GC 권한은 이 단계가 증명한다

`localstack`에서는 4·5를 건너뛴다. LocalStack은 설치와 함께 뜨고, API가 기동할 때 bucket의 versioning·Object Lock·`AES256`을 검사하며 `deploy`는 그 healthcheck를 기다린다.

그다음 `up -d --wait`로 api·scheduler·reconciler와 그 의존 서비스를 띄우고 healthcheck를 기다린다. scheduler의 첫 pass가 network isolation과 workspace quota probe를 돈다. 실패하면 scheduler·api 로그 끝부분을 출력하고 멈춘다.

### 첫 owner

웹 콘솔은 API와 같은 주소(3000)에서 열린다. 아래 "접근"의 터널을 연 뒤 `http://localhost:3000/bootstrap`에서 env 파일의 `BOOTSTRAP_TOKEN`, owner의 email·이름·비밀번호, workspace 이름·slug를 넣으면 첫 owner와 workspace가 생기고, 그 계정으로 `/login`에 로그인한다. env 파일에 `BOOTSTRAP_TOKEN`을 넣었다면 그 값을 편집기에서 복사해 붙이고 터미널에 출력하지 않는다. 넣지 않았다면 `scripts/test-ops.sh bootstrap-token`이 출력하는 값을 쓴다. 이 명령은 토큰을 한 번만 보이고, 다시 실행하면 토큰 없이 exit 1로 끝난다. 값을 놓쳤고 owner가 아직 없으면 `stop`과 `start`로 API를 다시 띄워 새 토큰을 만든다(이전 토큰은 무효).

bootstrap은 live owner가 없을 때 한 번만 통과한다. 같은 토큰을 다시 보내면 `409 BOOTSTRAP_DONE`이다. 나머지 사용자는 owner가 웹 콘솔에서 초대한다.

## 접근

API(기본 3000, `TEST_OPS_API_PORT`)는 호스트 loopback에만 열려 있다. 사용자는 SSH 터널로 들어온다. 포트를 바꿨으면 터널의 `127.0.0.1:` 뒤 숫자를 그 값으로 쓴다.

```bash
ssh -N -L 3000:127.0.0.1:3000 <user>@<test-ops-host>
curl -fsS http://127.0.0.1:3000/readyz
```

postgres(기본 5432, `TEST_OPS_POSTGRES_PORT`)도 loopback에만 열려 있다. 운영자만 호스트에서 쓴다.

## API key 발급과 폐기

```bash
scripts/test-ops.sh key create <owner_id> \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover
# stdout: 평문 key(한 번만 나온다), stderr: key_id
scripts/test-ops.sh key revoke <key_id>
```

scope는 [quickstart](../quickstart.md#1-clone과-기동)와 같다. `sessions:approve`가 없으면 권한 요청에 답하지 못해(403) `permission_mode: default` 세션이 첫 파일 변경에서 멈추고, `sessions:control`이 없으면 interrupt·pause·resume·terminate를, `sessions:recover`가 없으면 복구 결정을 못 한다.

`key_id`는 `create`가 stderr에 한 번만 낸다(`key_id <id>`). key 목록을 보는 명령은 없으므로, 시험용 key는 만들 때 stderr를 받아 두어야 나중에 `revoke`할 수 있다.

평문 key는 사용자에게 직접 전하고 저장하지 않는다. 퇴사나 분실 때는 `revoke`한다. 세션 실행 권한 회수(`grants.ts`)는 API 컨테이너 안에서 부른다. 인자는 각 파일의 usage를 따른다.

```bash
docker exec werft-test-ops-api-1 bun run apps/control-host/src/api/grants.ts revoke <session_id> --reason <text>
```

## provider key

test-ops는 운영자의 Anthropic key 하나를 모든 세션이 같이 쓴다.

- key는 콘솔의 모델 연결 화면(설정 > 에이전트 연결 > 모델 연결)에서 넣는 것이 기본이다. DB에 봉인돼 저장되고(`PLATFORM_SECRET_KEY`로 연다), 키를 넣기 전에는 그 연결의 release로 세션이 시작되지 않고 화면 경로를 알려 주는 오류가 난다. env로 두려면 env 파일의 `ANTHROPIC_API_KEY`를 채우고 연결이 `value_env`로 이름만 가리키게 한다. compose는 이 값을 API 컨테이너에만 넘긴다. worker는 key를 받지 않는다. egress proxy의 provider route가 요청마다 API에 물어 key를 붙인다.
- 비용은 세션별 `SESSION_COST_LIMIT_USD`(기본 25)로 막는다. Anthropic 콘솔에도 월 한도를 건다.
- 교체(화면에서 넣은 key): 콘솔에서 새 key를 만든다 → 모델 연결 화면에서 그 연결의 "값 바꾸기"로 새 key를 넣는다 → 세션 한 턴을 확인한다 → 옛 key를 폐기한다. env 파일은 건드리지 않는다. 저장형 연결은 env 값을 읽지 않으므로 env만 바꾸면 계속 옛 key로 돈다.
- 교체(env 참조 연결): 콘솔에서 새 key를 만든다 → env 파일 값을 바꾼다 → `scripts/test-ops.sh upgrade /var/lib/werft/test-ops/current.json`으로 같은 release를 다시 적용한다(바뀐 설정만 컨테이너를 새로 만든다) → `/readyz`와 세션 한 턴을 확인한다 → 옛 key를 폐기한다. 참조 이름이 같으므로 연결과 release spec은 바뀌지 않고 진행 중인 세션도 그대로 이어진다.

env 파일의 다른 값을 바꿀 때도 같은 명령을 쓴다.

## 업그레이드

```bash
git fetch && git checkout <new source_commit> && bun install --frozen-lockfile
scripts/test-ops.sh upgrade release-new.json
```

`upgrade`는 새 manifest로 preflight를 돈 뒤 다음 규칙을 따른다.

- **worker 이미지가 바뀌면 `scripts/verify-restore.sh --image <새 이미지>`의 restore plan으로 현재 checkpoint를 검사한다.** engine·SDK·CLI·profile digest가 모두 같아 호환되는 세션은 승인 없이 이어진다. `INCOMPATIBLE_CHECKPOINT`인 세션만 영향 목록에 올려 거부하고, id를 `$TEST_OPS_STATE_DIR/upgrade-<시각>.sessions`에 적는다. 종료 코드는 3이다. 검사를 끝까지 돌릴 수 없거나 불호환 외 실패가 하나라도 섞이면 fail-closed로 `collected_at IS NULL`인 checkpoint의 세션을 모두 영향 목록에 올리고 그 사실을 로그에 남긴다.
- 목록을 검토하고 사용자에게 알린 뒤, 정확히 그 id들을 담은 파일로 다시 부른다.

  ```bash
  scripts/test-ops.sh upgrade release-new.json --approve-sessions approved.txt
  ```

  승인 목록이 영향 목록과 하나라도 다르면 거부한다. worker 이미지가 바뀌면 writer를 멈추고(아래 "백업"과 같은 순서) 같은 restore plan 검사를 한 번 더 한다. 그 사이 새 checkpoint가 생기거나 호환 판정이 바뀌어 목록이 달라졌으면 원래 release를 다시 열고 거부한다. 진행하면 `approvals/<시각>-upgrade.json`에 시각·운영자·전후 worker 이미지·세션 목록을 남긴다. 불호환 세션을 `start_fresh`로 복구하면 이전 checkpoint의 context를 잃는다.
- 영향받는 세션이 없으면 승인 없이 진행한다. worker 이미지가 같으면 writer도 멈추지 않고, 설정이나 이미지가 바뀐 컨테이너만 새로 만든다.
- `settings_digest`가 바뀌면 migrate를 다시 돌려 설정 문서의 새 항목을 더한다. API는 DB를 주기적으로 다시 읽으므로 설정 때문에 다시 만들지 않는다. 설정 문서가 생기기 전 release의 `current.json`(`catalog_revision`)에서 올릴 때도 migrate가 돈다.
- 끝나면 `current.json`을 새 manifest로 바꾸고 `history.log`에 한 줄 남긴다.
- 게이트를 통과한 순간(writer를 멈추기 전) 새 manifest를 `pending.json`에 적는다. 새 release가 뜨기 전에 실패하면(예: scheduler quota probe 실패) 설치가 멈춘 채로 남을 수 있고, 그때 `pending.json`이 남아 원인을 고친 뒤 같은 manifest로 `upgrade`를 다시 부를 때까지 `status` 말고 다른 명령은 모두 거부한다.

**`v0.1.3`으로 올릴 때는 `openai_responses` 연결(Codex 엔진)을 쓰기 전에 egress proxy를 새 이미지로 올린다.** 옛 proxy는 `/v1/responses`를 `404`로 거절한다. control-host만 새 버전인 동안 만든 `openai_responses` 연결의 세션은 모델을 부르지 못하고 실패한다. manifest 하나로 모든 이미지를 함께 올리면 이 구간은 컨테이너를 다시 만드는 동안뿐이다. 이미지를 나눠 올리면 proxy를 먼저 올리거나, proxy를 올릴 때까지 `openai_responses` 연결을 만들지 않는다. Claude 연결(`/v1/messages`)은 어느 순서에서도 그대로 동작한다. `v0.1.3` proxy는 이 호출에 `v0.1.2` API가 모르는 필드를 보내지 않는다.

되돌리기는 이전 manifest로 `upgrade`하는 것이다. worker 이미지가 다시 바뀌므로 같은 규칙이 적용된다. 업그레이드 전에는 백업을 한 번 찍는다.

### 내장 Gitea를 쓰던 설치

내장 Gitea를 뺀 release로 올리기 전에 다음을 한다. `upgrade`는 Gitea를 대신 지우지도 옮기지도 않는다.

1. 남길 저장소를 GitHub로 옮기고, 설정의 저장소 URL을 바꾼다. 설정의 URL이 세션에 기록된 URL과 달라지면 그 세션은 `CATALOG_MISMATCH`로 새 입력을 받지 못한다.
2. env 파일의 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에서 `gitea:3000`을 뺀다. 없는 호스트를 가리키는 값이고, preflight는 이 값을 잡지 않으므로 직접 확인한다.
3. 이전 release의 checkout에서 마지막 백업을 뜬다. 새 release의 백업에는 Gitea가 들어가지 않고, Gitea가 든 백업은 새 release에서 복원되지 않는다([backup-restore.md](backup-restore.md#내장-gitea를-쓰던-때의-백업)).
4. `upgrade`한다. 서비스 정의가 사라져도 기존 컨테이너는 그대로 돌고 3001을 계속 연다. 확인한 뒤 `docker rm -f <project>-gitea-1`로 내린다.
5. `<project>_gitea-data` volume은 자동으로 지워지지 않는다. `reset`도 지우지 않는다. 저장소를 다 옮겼다고 확인한 뒤에 운영자가 `docker volume rm`으로 지운다. 이 volume이 남아 있으면 `deploy`가 같은 project를 거부한다.

## 백업

```bash
scripts/test-ops.sh backup
```

1. 신규 접수를 멈춘다: api, scheduler, reconciler를 멈추고, scheduler가 띄운 worker 컨테이너(`werft.installation=<id>` label)도 멈춘다. 진행 중이던 턴은 끊기고, 다시 열린 뒤 reconciler가 lease 만료로 회수한다.
2. `scripts/backup.sh`로 DB·checkpoint object를 `$TEST_OPS_STATE_DIR/backups/backup-<시각>`에 묶는다. object는 `localstack`이면 설치의 LocalStack에서(`--object-store localstack`), `s3`면 API의 자격 증명으로 bucket에서(`--object-store env`) 읽는다. backup.sh가 writer가 남았는지 스스로 다시 보고, 남았으면 거부한다. 실패한 백업은 `.failed`로 남고 성공본 이름을 얻지 못한다.
3. 성공하든 실패하든 멈춘 서비스를 그대로(재생성 없이) 다시 연다. 다시 열지 못하면 백업이 성공했어도 명령은 실패로 끝난다. `status`로 확인하고 원인을 고친 뒤, `current.json`의 사본으로 `upgrade`를 부르면 같은 release로 다시 뜬다. `--stop`을 붙이면 다시 열지 않는다(아래 "재시작").

주기: 매일 한 번, 사용이 적은 시간에. 그리고 업그레이드 직전. `localstack`에서는 백업이 재시작 뒤 되살릴 수 있는 유일한 사본이므로 주기를 지킨다. 백업 디렉터리에는 DB 전체가 들어 있다. `0700`으로 두고, 호스트 밖 보관소에 암호화해 복사한다. checkpoint GC는 백업과 겹치면 안 된다. 백업 중에는 API가 멈춰 있으므로 GC를 부를 수 없다.

## 재시작

### 계획 재시작(`localstack`)

호스트 재부팅, Docker 업그레이드처럼 미리 아는 재시작은 다음 순서로 한다. LocalStack의 object를 백업에서 되살린다.

```bash
scripts/test-ops.sh backup --stop          # 백업하고 writer를 멈춘 채로 둔다
sudo reboot                                # 또는 Docker 재시작
scripts/test-ops.sh reseed /var/lib/werft/test-ops/backups/backup-<시각>
```

`reseed`가 하는 일:

1. 렌더가 `preflight`의 렌더 검사를 `settings_digest`만 빼고 통과하고, manifest의 project·bucket이 이 설치와 같고, 체크섬과 schema가 맞는지 본다.
2. writer를 멈춘 채 postgres와 LocalStack을 띄운다. LocalStack의 bucket이 비어 있어야 한다. 비어 있지 않으면 재시작이 없었다는 뜻이므로 거부한다.
3. `scripts/restore.sh`가 새 bucket을 채우는 방식 그대로 object를 올린다: create-only 업로드 뒤, 모든 미수거 checkpoint를 새 version으로 re-pin하고 legal hold를 건다. re-pin은 쓰기 전에 DB의 모든 미수거 checkpoint를 올린 바이트와 대조한다. 백업 뒤에 DB가 바뀌었으면 여기서 거부한다.
4. object 수가 백업과 같으면 설치를 다시 띄우고 `history.log`에 남긴다.

실패하면 writer를 멈춘 채로 둔다. 그때는 아래 `reset`밖에 없다. 재시작을 취소했다면 `reseed` 대신 `current.json`의 사본으로 `upgrade`를 불러 다시 연다.

### 예상하지 못한 재시작(`localstack`)

재시작 뒤에는 API가 뜨지 않는다(위 "LocalStack의 한계"). 마지막 백업 뒤에 새 checkpoint가 없었다면 그 백업으로 `reseed`가 통한다. 거부되면 초기화한다.

### 초기화

```bash
scripts/test-ops.sh reset --yes
scripts/test-ops.sh deploy /var/lib/werft/test-ops/reset-<시각>.json
```

`reset`은 이 설치의 컨테이너와 volume(DB, LocalStack), scheduler가 만든 worker 컨테이너·네트워크·workspace volume을 모두 지운다. 배포했던 manifest는 `reset-<시각>.json`으로 남긴다. API key도 DB와 함께 지워지므로 다시 발급한다. 저장소를 바꾸려면 두 번째 줄에서 `TEST_OPS_OBJECT_STORE`를 준다.

### `s3`

AWS S3의 object는 재시작에 사라지지 않는다. 재시작 뒤에는 `scripts/test-ops.sh start`로 `current.json`의 release를 다시 띄운다. 내려간 설치에서 `upgrade`는 postgres가 실행 중이지 않아 실패한다.

## 복원 훈련

`localstack`에서는 백업을 새 project와 그 project의 LocalStack에 복원한다. bucket은 만들지 않는다.

```bash
scripts/test-ops.sh restore-drill /var/lib/werft/test-ops/backups/backup-<시각>
```

`s3`에서는 훈련을 새 project와 **새로 만든 빈 bucket**에만 복원한다. 복원 대상 bucket이 백업의 원본 bucket 이름이거나 object version·delete marker가 하나라도 있으면 `scripts/restore.sh`가 거부한다(종료 코드 4). 훈련마다 bucket을 새로 만든다. 설정은 운영 bucket과 같다.

```bash
drill=werft-test-ops-drill-$(date -u +%Y%m%d)
aws s3api create-bucket --bucket "$drill" --region ap-northeast-1 \
  --create-bucket-configuration LocationConstraint=ap-northeast-1 --object-lock-enabled-for-bucket
aws s3api put-bucket-encryption --bucket "$drill" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

scripts/test-ops.sh restore-drill /var/lib/werft/test-ops/backups/backup-<시각> --bucket "$drill"
```

`restore-drill`은 `<project>-drill-<시각>-<무작위>` project에 postgres·LocalStack을 25432·25433 포트(`--port-base`로 바꾼다. `s3`에서는 LocalStack 없이)로 띄워 복원하고, `scripts/verify-restore.sh`로 모든 checkpoint pointer를 version 단위로 대조한다. 출력은 `restore-drills/<project>.log`에 남고, 판정(passed/FAILED)은 `history.log`에 한 줄 남는다. 끝나면 훈련 project를 지운다. 들여다보려면 `--keep`을 붙인다. migrate는 배포한 control-host 이미지로 돈다.

주기: 한 달에 한 번, 그리고 업그레이드 뒤 첫 백업마다. `s3`에서 훈련 bucket의 object에는 legal hold가 걸려 있다. bucket을 지우려면 version마다 hold를 풀고(`aws s3api put-object-legal-hold --legal-hold Status=OFF --version-id …`) version을 지운 뒤 bucket을 지운다.

## 감시 지점

```bash
scripts/test-ops.sh status
```

컨테이너 상태, 배포된 manifest, object store, `/readyz`, scheduler·reconciler `--health`, 미수거 checkpoint가 있는 세션 수, Docker 데이터 루트의 디스크 사용량을 한 번에 보여 준다. 따로 볼 때는 다음을 본다.

| 지점 | 보는 법 | 정상 |
|---|---|---|
| API | `curl -fsS http://127.0.0.1:3000/readyz` | `"status":"ready"` |
| scheduler | `docker exec werft-test-ops-scheduler-1 cat /tmp/scheduler-status.json`, 또는 컨테이너 health | 최근 성공 pass, healthy |
| reconciler | `docker exec werft-test-ops-reconciler-1 cat /tmp/reconciler-status.json` | 같음 |
| 디스크 | `df -h "$(docker info -f '{{.DockerRootDir}}')"`, `xfs_quota -x -c 'report -p'` | 여유 20% 이상 |
| checkpoint GC | `docker exec -e CHECKPOINT_GC_DRY_RUN=1 werft-test-ops-api-1 bun run apps/control-host/src/api/checkpoint-gc.ts`로 먼저 확인하고 `-e` 없이 실행한다. 주 1회. 백업과 겹치지 않게 | exit 0 |
| LocalStack(`localstack`) | `docker inspect -f '{{.State.StartedAt}}' werft-test-ops-localstack-1` | 마지막 백업보다 먼저 시작했다. 백업 뒤에 재시작했다면 object가 없다 |
| S3(`s3`) | AWS 콘솔의 bucket 크기와 요청 오류 | |

찾아볼 로그 이벤트(`docker compose logs`나 `docker logs <컨테이너>`):

- api: `Refusing to start: …`(설정·상한 오류), `Checkpoint bucket … holds no object version`(LocalStack이 재시작돼 object를 잃었다. 위 "재시작"), `Unhandled API request error`, `Egress authorization failed`
- scheduler: `Workspace quota preflight failed; …`, `Network isolation preflight failed; …`, `Database connection lost; …`, `Worker workspaces have no disk or inode quota`(quota가 꺼진 채 떴다는 뜻이다)
- checkpoint GC: `Checkpoint GC failed for a session`

OpenTelemetry 지표는 아직 없다(트레이스는 설정하면 OTLP로 내보낸다. 키는 [api-server.md](api-server.md#트레이스-내보내기-otlp)). 관측은 위 상태 파일, DB 쿼리, 구조화 로그이며, 선택형 Datadog Agent·초기 monitor·계측 공백의 정본은 [Datadog 감시 기준](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/monitoring-datadog/)이다.

선택형 Datadog Agent를 test-ops S3 설치에 얹는 예시는 다음과 같다. 기존 배포 명령의 layer는 그대로 두고 마지막에 overlay만 더한다. Datadog용 변수 파일에는 `DD_ENV`와 `DD_VERSION`이 필요하다([Datadog 감시 기준](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/monitoring-datadog/)).

```bash
docker compose \
  --env-file /etc/werft/test-ops.env \
  --env-file /etc/werft/datadog.env \
  -f infra/compose.core.yml \
  -f infra/compose.test-ops.yml \
  -f infra/compose.test-ops.s3.yml \
  -f infra/compose.datadog.yml \
  --profile apps up -d
```
