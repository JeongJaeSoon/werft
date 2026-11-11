# 백업과 복원 (compose 설치)

`scripts/backup.sh`가 한 compose 설치(PostgreSQL·checkpoint object store)를 디렉터리 하나로 묶고, `scripts/restore.sh`가 그것을 **새 compose project**에 풀며, `scripts/verify-restore.sh`가 복원된 checkpoint pointer가 가리키는 object를 version 단위로 대조한다. 복원된 checkpoint는 새 bucket의 version으로 **다시 고정**되고 legal hold가 걸리므로, 복원본의 API도 기본값 `CHECKPOINT_OBJECT_PROTECTION=locked`로 뜬다(아래 "checkpoint 객체의 version" 절). 원본 설치의 volume·환경 파일은 어느 스크립트도 쓰지 않는다([development.md](../contributing/development.md#의존-서비스만-띄우기와-host에서-도는-api)의 규칙).

호스트에 필요한 것: docker + compose v2.24.6 이상(`!override` 병합, `include`로 합친 스택 위의 overlay), git, jq, `sha256sum` 또는 `shasum`, 그리고 `bun install`을 마친 이 저장소 checkout. restore의 `migrate` 서비스가 checkout을 마운트한다. S3 호출은 모두 호스트에서 production S3 어댑터로 한다. object 복사·업로드·검사는 `scripts/lib/object-store-cli.ts`, checkpoint version 고정은 `scripts/lib/checkpoint-pins-cli.ts`가 맡는다(published postgres 포트로 붙는다). verify는 `scripts/lib/decode-manifest.ts`도 부른다. pg_dump·psql·git은 컨테이너 안에서 실행한다.

test-ops 설치에서는 이 스크립트들을 직접 부르지 않는다. `scripts/test-ops.sh backup`·`restore-drill`·`reseed`가 writer를 멈추고 설치의 object store(LocalStack 또는 API의 S3 설정)로 부른다([test-ops.md](test-ops.md)).

## Kubernetes 설치

[Kubernetes 설치](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-deployment/)에서는 이 문서의 세 스크립트를 쓰지 않는다. 스크립트는 compose project의 PostgreSQL·로컬 S3 컨테이너를 전제로 한다. 대신 AWS 기능이 같은 일을 한다.

- **DB**: RDS 자동 백업(point-in-time 복원)과 수동 스냅샷.
- **checkpoint object**: S3 versioning과 Object Lock. 커밋된 checkpoint는 version으로 고정되고 legal hold가 걸려 있어(`locked`, 아래 "checkpoint 객체의 version" 절), 같은 key를 덮어쓰거나 지워도 그 version은 남는다. 복원은 bucket을 복사하지 않고 같은 bucket의 version을 그대로 가리킨다.

bucket은 DB와 함께 설치의 정본이다. [세션 이벤트 보관](data-retention.md#세션-이벤트-보관)이 `session-archive/` 아래로 옮긴 이벤트는 그 object가 유일한 사본이다. DB만 되살리고 bucket을 잃으면 그 세션의 이벤트는 읽을 수 없다.

checkpoint object의 삭제는 chart의 checkpoint GC CronJob(`checkpointGc.schedule`, 기본 `0 4 * * 0`)만 한다. **만료 규칙은 두지 않는다. `session-archive/`에 storage class 이동만 허용한다.** API가 요청마다 이 object를 바로 읽으므로 즉시 읽히는 class(`STANDARD_IA`, `ONEZONE_IA`, `GLACIER_IR`, archive tier를 켜지 않은 `INTELLIGENT_TIERING`)로만 옮긴다. `GLACIER`·`DEEP_ARCHIVE`로 옮기면 그 세션의 이벤트를 읽지 못한다. 보관한 이벤트 object는 아무것도 지우지 않으며 legal hold가 걸려 있다. GC는 DB를 읽고 현재 pointer와 그 부모가 가리키지 않는 revision만 골라, legal hold를 푼 뒤 그 version을 지우고 행에 `collected_at`을 적는다. lifecycle 규칙은 나이와 prefix만 보고 DB를 모른다. 그래서 둘이 겹치면 다음 일이 생긴다.

- hold가 걸리기 전의 object(worker가 올렸고 finalize가 아직 검증 중인 것)나 GC가 hold를 푼 version을 lifecycle이 먼저 지운다. finalize가 실패하거나, GC가 행을 표시하기 전에 object가 사라진다.
- hold가 걸린 version은 lifecycle이 지우지 못한다. 저장량은 lifecycle로 줄지 않고 GC로만 준다(api-server.md의 "한계: checkpoint 바이트").

RDS 스냅샷은 그 시점의 pointer를 담는다. 스냅샷 뒤에 GC가 지운 revision을 그 스냅샷의 pointer가 가리킬 수 있다. 스냅샷 보존 기간과 GC 주기를 어떻게 맞출지, 실제 복원 절차는 실제 RDS·S3로 하는 복원 훈련에서 정한다(보류: AWS 리소스가 생긴 뒤 재개).

## object store 고르기

세 스크립트는 `--object-store`로 checkpoint object가 있는 곳을 고른다.

| 값 | 대상 | 접속 정보 |
|---|---|---|
| `localstack`(기본값) | compose project의 로컬 S3(SeaweedFS, 서비스 이름 `localstack`) | published 4566 포트. 자격 증명과 region은 `docker inspect`로 그 컨테이너가 받은 env에서 읽는다 |
| `env` | 호출 셸이 가리키는 S3 호환 저장소(AWS S3 포함) | API와 같은 변수(`checkpointStorageConfigFromEnv`): `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, 그리고 `AWS_ENDPOINT_URL`(없으면 AWS S3). 세 변수 중 하나라도 없으면 시작하지 않는다 |

`env` 대상 자격 증명에 필요한 S3 권한은 다음과 같다.

- backup: `s3:ListBucket`, `s3:GetObject`, `s3:GetObjectVersion`
- restore·verify: 위 권한과 `s3:ListBucketVersions`, `s3:GetBucketVersioning`, `s3:GetBucketObjectLockConfiguration`, `s3:GetEncryptionConfiguration`, `s3:PutObject`, `s3:GetObjectLegalHold`, `s3:PutObjectLegalHold`, `s3:DeleteObjectVersion`. 마지막 권한은 create-only 검사가 scratch key의 version을 version id로 지우는 데 쓴다

macOS에서 Homebrew bash 5.3.9가 PATH 앞에 있으면 1 KB가 넘는 here-string·heredoc에서 멈춘다(`cat <<< "$(seq 1 300)"`가 돌아오지 않는다). 스크립트는 `#!/usr/bin/env bash`이므로 `/bin`을 PATH 앞에 두어 /bin/bash 3.2로 실행한다.

## 백업

```bash
scripts/backup.sh                       # project werft → backups/backup-<ts>/
scripts/backup.sh --project ap125 --out /somewhere --bucket claude-sessions
scripts/backup.sh --project ap-ops --object-store env --bucket ap-ops-checkpoints   # AWS_* 는 셸에서
```

백업은 `backup-<ts>.partial`에 쓰고, 모두 끝나야 `backup-<ts>`로 이름을 바꾼다. 도중에 실패하면 `backup-<ts>.failed`로 남는다. 강제 종료처럼 이름을 바꿀 틈이 없었으면 `.partial`로 남는다. 접미사가 붙은 디렉터리는 백업이 아니다.

```
backup-20260923T101500Z/
├── db.sql          pg_dump --no-owner --no-privileges (schema·data·drizzle journal)
├── objects/        bucket의 모든 object, key가 곧 경로 (checkpoint가 고정한 key는 그 version의 바이트)
├── manifest.json   아래 참조
└── SHA256SUMS      위 파일 전부
```

백업에는 git 호스트가 들어가지 않는다. 로컬 스택의 git 호스트는 읽기 전용 fake-git이라 지킬 데이터가 없고, 그 밖의 저장소는 GitHub에 있다.

내장 Gitea를 쓰던 때의 `<project>_gitea-data` volume이 남아 있으면 백업은 경고를 남기고 그 volume을 넣지 않는다. 그 저장소가 필요하면 volume을 지우지 말고 따로 옮긴다.

`manifest.json`:

| 필드 | 내용 |
|---|---|
| `version` | 백업 형식 버전(현재 1). restore는 같은 값만 받는다 |
| `source` | compose project 이름, 백업을 만든 checkout commit과 dirty 여부 |
| `schema.applied[]` | DB의 `drizzle.__drizzle_migrations` 행(`hash`, `when`) 순서대로. `head_tag`는 마지막 행에 해당하는 journal tag |
| `images.<service>` | 실행 중인 컨테이너의 image·image id·registry digest. api/worker/scheduler 컨테이너가 없으면 `status: "not_built"`로 남긴다. 나중에 만든 이미지를 이 값에 소급 기록하지 않는다 |
| `objects` | `store`(`localstack`·`env`), bucket 이름, `endpoint`(백업이 읽은 주소, AWS S3면 빈 문자열), object 수. restore는 이 bucket 이름을 대상으로 받지 않는다 |

주의:

- 로컬 compose의 S3는 SeaweedFS이며 객체·메타데이터·암호화 키를 `local-s3-data` named volume에 보존한다. Docker 재시작과 `docker compose down`(`-v` 없이) 뒤에도 남는다. 보존하며 내릴 때는 `scripts/local.sh down --keep-volumes`를 쓴다. 옵션 없는 `scripts/local.sh down`과 `reset`은 데이터까지 지우므로 보존할 때 쓰지 않는다. 이전 휘발성 LocalStack 설치에서 전환할 때는 **pull 전 옛 checkout에서 백업**하고, pull 뒤 사용한 적 없는 새 project에 restore한다. 이미 유실된 checkpoint는 백업으로 되살릴 수 없으며 [전환 안내](../quickstart.md#재부팅이나-docker-재시작-뒤)의 명시적 복구 결정을 따른다.
- `pg_dump`는 자체로 일관되지만 object는 그 뒤에 복사한다. 백업 중 checkpoint가 커밋되면 pointer만 있고 object가 없는 행이 생길 수 있다. 그래서 writer가 돌고 있으면 백업은 아무것도 쓰지 않고 exit 1로 거부한다. writer는 compose 서비스 api·scheduler·reconciler·maintenance·worker와, scheduler가 띄운 worker 컨테이너다. worker 컨테이너는 `werft.installation=<scheduler 컨테이너의 EXECUTION_INSTALLATION_ID>` 라벨로 찾는다. scheduler 컨테이너가 없으면 설치 id를 알 수 없으므로 `werft.installation` 라벨이 붙은 컨테이너는 어느 설치 것이든 writer로 센다. 서비스는 compose 라벨로 찾으므로 `apps` profile 밖에서도 보인다. docker가 답하지 않으면 거부한다. `--allow-running-writers`를 주면 경고만 하고 진행한다.
- checkpoint GC(`apps/control-host/src/api/checkpoint-gc.ts`)는 백업 중에 돌리지 않는다. GC는 더 이상 복원될 수 없는 revision의 행에 `collected_at`을 적은 뒤 그 객체를 지운다. capture와 repin은 이렇게 표시된 행을 건너뛴다. 그런데 `pg_dump` 뒤에 GC가 행을 표시하면, 덤프에는 표시가 없는 행이 남고 그 객체는 백업에 없다. 그러면 restore의 repin이 실패한다. 그래서 `backup.sh`는 객체 복사를 마친 뒤 `pg_dump` 시작 1분 전 이후에 `collected_at`이 적힌 행이 있는지 확인하고, 있으면 백업을 실패로 끝낸다. GC를 멈추고 다시 백업한다.
- object 복사(`object-store-cli.ts download`)는 각 key의 **현재** 객체만 받는다. 그 뒤 `checkpoint-pins-cli.ts capture`가 `collected_at`이 비어 있는 `checkpoints` 행을 모두 읽고 다음을 확인한다.
  - manifest는 `manifest_version`으로, 그 안의 모든 ref는 자기 `version`으로 읽는다. incremental checkpoint의 `workspace.baseBundles`도 ref다. base bundle은 앞 checkpoint의 디렉터리에 있지만, 그 checkpoint가 GC로 빠졌어도 이 checkpoint의 ref로서 백업된다. version이 없는 행(`unversioned`로 커밋된 행)은 key로 읽는다.
  - sha256과 크기를 대조한다.
  - `objects/<key>`가 고정된 바이트와 다르거나 없으면 고정된 바이트로 바꾸고 경고한다. 커밋 뒤 덮어쓰기나 delete marker가 있어도 백업이 손상본을 담지 않게 하려는 것이다.
- capture는 `session_event_archives`의 모든 행도 읽는다. 보관한 이벤트 object를 행의 `version_id`로 읽고 sha256과 크기를 대조한 뒤, `objects/<key>`가 그 바이트와 다르면 바꾼다. 이 object는 DB에서 빠진 이벤트의 유일한 사본이다.
- 다음 경우에는 백업이 실패한다(exit 1).
  - 고정된 version이 없거나 해시가 맞지 않는다. 보관한 이벤트 object도 같다.
  - 한 key에 서로 다른 바이트가 고정되어 있다(`objects/<key>` 파일 하나로 둘을 담을 수 없다).
  - 한 checkpoint의 manifest key를 다른 checkpoint가 ref로 쓴다. 복원 때 manifest를 다시 쓸 수 없다.
- `db.sql`에는 api key 해시가 들어 있다. 디렉터리는 `umask 077`로 만들어지며 보관 위치는 백업 소유자가 책임진다.

## 복원

```bash
scripts/restore.sh backups/backup-20260923T101500Z --into ap-restore-1 --port-base 25432
scripts/restore.sh <dir> --into <project> --check-only   # 검사만, 아무것도 띄우지 않음
scripts/restore.sh <dir> --into ap-drill-1 --object-store env --bucket ap-drill-1-checkpoints   # 새 빈 bucket
```

`localstack`이면 새 project의 로컬 S3에 백업의 bucket 이름으로 복원한다. `env`면 `--bucket`이 필수이고, 새 project에는 로컬 S3를 띄우지 않는다. 대상 bucket은 운영자가 미리 만든다. versioning, Object Lock, 기본 암호화 SSE-S3(`AES256`)를 켜고, 아무것도 없는 상태여야 한다. Object Lock 기본 보존 기간(default retention)은 두지 않는다. checkpoint는 legal hold로만 지키고, 기본 보존이 있으면 restore가 거부한다. Object Lock은 bucket을 만들 때만 켤 수 있다. AWS CLI가 없는 로컬 S3 호환 저장소(SeaweedFS)에서는 `AWS_*`를 셸에 두고 `S3_BUCKET=ap-drill-1-checkpoints bun run scripts/lib/object-store-cli.ts check-target --create`가 이 조건으로 bucket을 만들고 검사한다.

순서와 거부 조건:

1. `SHA256SUMS` 검증. 불일치면 exit 1.
2. **Gitea 데이터 검사** — manifest의 `gitea`가 `null`이 아니면 exit 3으로 거부한다. 아래 "내장 Gitea를 쓰던 때의 백업"을 본다. `gitea`가 `null`이거나 없는 백업은 그대로 진행한다.
3. **schema 검사** — manifest의 `schema.applied`가 이 checkout `packages/db/migrations`의 journal(각 SQL 파일 sha256, journal 순서)과 정확히 같아야 한다. 오래된 백업도, 이 checkout이 모르는 migration이 든 백업도 exit 3으로 거부한다. 오래된 백업을 올리려면 그 백업과 같은 commit을 checkout해 복원·검증한 뒤 migration을 별도 단계로 돌린다.
4. `env`면 대상 bucket 검사(아래 8.1–8.2와 같은 것)를 docker를 건드리기 전에 먼저 한다. `--check-only`도 이 검사를 한다.
5. 대상 project 이름을 label로 가진 container·volume·network가 하나라도 있으면 exit 4. 기존 설치는 절대 재사용하지 않는다. 같은 이름으로 동시에 들어오는 restore는 `<project>-restore-lock` network 생성으로 하나만 통과한다(끝나면 제거).
6. `infra/compose.restore.yml`을 겹쳐 postgres(`localstack`이면 localstack도)를 띄운다. git 호스트는 띄우지 않는다. 복원한 apps를 올릴 때 함께 뜬다. 이 override는 host port를 `--port-base`부터 loopback에 다시 묶고(postgres, localstack, git 호스트 순. 스크립트가 `RESTORE_POSTGRES_PORT`·`RESTORE_LOCALSTACK_PORT`·`RESTORE_GIT_HOST_PORT`로 넘긴다), postgres의 initdb SQL 마운트를 없애 dump가 빈 DB에 들어가게 한다.
7. `psql --single-transaction < db.sql` → 복원된 journal이 manifest와 같은지 재확인.
8. object와 재고정. 첫 쓰기 직전에 대상 bucket을 다시 검사한다(`object-store-cli.ts check-target`).
   1. `env`에서 대상 bucket 이름이 백업의 원본 bucket(`manifest.json`의 `objects.bucket`)과 같으면 endpoint와 상관없이 exit 4로 거부한다. 같은 저장소도 여러 주소로 부를 수 있어서(AWS S3의 전역·리전 endpoint, `localhost`와 `127.0.0.1`) 주소 비교로는 원본이 아님을 증명할 수 없다. 다른 저장소로 훈련할 때도 다른 이름의 bucket을 쓴다. `localstack`이면 대상이 방금 띄운 새 로컬 S3라 원본일 수 없다. bucket이 없으면 Object Lock과 SSE-S3로 만든다. 기본 `claude-sessions`는 `local-s3-init`이 만든다.
   2. versioning `Enabled`, Object Lock `Enabled`(기본 보존 기간 없음), 기본 암호화 `AES256`인지 확인한다. 아니면 exit 1이다. version이나 delete marker가 하나라도 있으면 exit 4로 거부한다.
   3. 저장소가 `If-None-Match: *` 두 번째 쓰기를 412로 거부하는지 scratch key로 확인한다. 확인이 끝나면 scratch key의 version과 delete marker를 모두 version id로 지우고, bucket이 다시 비었는지 본다.
   4. `checkpoints` 행이 가리키는 manifest key를 **빼고** `object-store-cli.ts upload`로 올린다. 모든 쓰기는 create-only(`If-None-Match: *`)다. 그 사이 누가 같은 key를 썼으면 멈춘다. 빈 bucket 검사는 다른 writer를 막지 못한다. 그래서 대상 bucket은 이 복원 전용으로 새로 만든다. 다른 설치의 자격 증명이 그 bucket에 쓸 수 없게 하는 것은 운영자 몫이다.
   5. `checkpoint-pins-cli.ts repin`이 재고정한다. 먼저 모든 행을 쓰기 없이 검증한다. 백업 manifest가 행의 sha256과 맞는지, 모든 ref가 복원 bucket에서 같은 바이트의 version으로 있는지 본다.
   6. 그 뒤 manifest를 새 version으로 다시 써서 같은 key에 create-only로 만든다. version으로 다시 읽어 확인하고, 모든 version에 legal hold를 건다. 마지막으로 모든 행의 `manifest_sha256`·`manifest_version`·`versions_held=true`를 한 트랜잭션으로 바꾼다.
   7. `session_event_archives` 행도 같은 순서를 따른다. 쓰기 전에 행마다 복원 bucket에서 같은 바이트의 version을 찾고, 하나라도 없거나 다르면 아무것도 쓰지 않고 멈춘다. 그 version에 legal hold를 건 뒤, 위 트랜잭션 안에서 `version_id`를 새 version으로 바꾼다. 행의 `version_id`가 그사이 바뀌었으면 트랜잭션 전체를 되돌린다.
   8. object 수가 manifest와 같아야 한다.
   9. 재고정이 실패하면 restore는 exit 1로 끝난다. 이미 올라간 object와 hold는 되돌릴 수 없으므로, 그 project는 내리고 새 project로 다시 복원한다. 이미 있는 object를 덮어쓰는 경로는 없다.
9. `migrate` 서비스를 한 번 돌려 `db.migrate.noop`을 확인한다.

끝나면 접속 정보, 다시 띄우는 명령, 정리 명령(`docker compose -p <project> -f infra/compose.yml down -v`)을 출력한다.

복원 project는 **항상 restore override와 같은 `RESTORE_*` 값으로** 다시 띄운다(출력된 "start again" 명령). base 파일만으로 `up`하면 컨테이너가 재생성되며 원본 포트(5432·4566·3001)와 공용 worker network로 되돌아가 원본 설치와 충돌한다. 복원본을 원본 자리로 승격하는 절차는 아직 없다.

### 내장 Gitea를 쓰던 때의 백업

manifest의 `gitea`에 값이 있는 백업에는 `repos/`와 `gitea/`(Gitea DB, `app.ini`의 secret 포함)가 들어 있다. 지금 checkout에는 이것을 풀 Gitea가 없으므로 `restore.sh`가 exit 3으로 거부하고, 아무것도 띄우지 않는다. 같은 migration이어도 거부한다. 백업 파일은 그대로 남는다.

그런 백업은 Gitea 제거 전 checkout에서 복원한다.

1. 거부 메시지가 알려 주는 `source.checkout_commit`을 checkout한다. 백업과 같은 migration이어야 schema 검사를 지난다.
2. 그 값이 `unknown`이거나 메시지에 `with local changes`가 붙으면 그 commit이 백업을 뜬 코드와 같다고 보장할 수 없다. manifest의 `schema.head_tag`가 마지막 migration인 commit 중 Gitea 복원이 있는 것을 고르거나, 배포 때 보관한 checkout을 쓴다.
3. 그 checkout의 `scripts/restore.sh`로 새 project에 복원한다. 저장소만 필요하면 복원 없이 `repos/<owner>/<repo>.bundle`을 `git clone`해도 된다.

## 검증

```bash
scripts/verify-restore.sh --project ap-restore-1
scripts/verify-restore.sh --project ap-drill-1 --object-store env --bucket ap-drill-1-checkpoints
scripts/verify-restore.sh --project ap-restore-1 --image werft-worker:dev   # 복원본을 이어 받을 worker 이미지
```

restore와 같은 `--object-store`와 bucket을 준다. restore가 끝에 출력하는 verify 명령에 둘 다 들어 있다. `--image`에는 복원본의 scheduler가 쓸 `WORKER_IMAGE`를 준다. 설정은 복원본 DB의 것을 읽는다.

`checkpoints`의 모든 행을 확인한다. 단, GC가 `collected_at`을 적은 행은 뺀다. 확인하는 내용은 다음과 같다.

1. `manifest_ref`를 **`manifest_version`으로** 내려받아 sha256 = `manifest_sha256`인지 본다. 행의 `versions_held`는 true여야 한다.
2. manifest 안의 transcript part(root·subagent), untracked 파일, 저장된 성과물(`outputs`), workspace bundle 사슬(`workspace.baseBundles`와 `workspace.bundle`)을 **각자의 `version`으로** 내려받아 sha256과 크기를 대조하고 legal hold가 ON인지 본다. version이 없는 ref는 재고정되지 않은 것이므로 FAIL이다. 크기 제한으로 생략된 output(`omitted`)은 object가 없어 건너뛴다. restore plan의 artifact 목록에는 outputs가 없으므로, API restore plan 검사(아래)도 manifest의 저장된 outputs를 plan의 object와 같은 방식으로 읽고 hold를 확인한다.
3. 1과 2의 모든 version에 대해 HEAD의 `ObjectLockLegalHoldStatus`가 `ON`인지 본다.
4. 행마다 빈 bare 저장소를 새로 만들고, bundle 사슬을 `baseBundles`의 오래된 것부터 `workspace.bundle`까지 순서대로 `git bundle verify`한 뒤 fetch해 쌓는다. incremental bundle은 앞 bundle이 가진 커밋을 전제로 하므로 혼자서는 verify되지 않는다. 마지막 bundle의 `refs/checkpoint/worktree`를 커밋까지 벗겨 `workspace.gitCommit`과 같은지 확인한다. 복원이 checkout하는 것이 이 ref다. 앞 checkpoint 뒤 바뀐 것이 없는 capture는 앞 bundle이 가진 커밋 위에 annotated tag만 싣기 때문에, bundle 헤더에는 커밋 대신 tag가 나온다. 순서가 틀리거나 한 고리가 빠지면 FAIL이다(`unbundle_chain`, `scripts/lib/backup-lib.sh`). finalize와 워커 복원이 bundle ref에 적용하는 규칙 전체는 runtime-core의 `checkpointBundleRefs`에 있다. 스크립트는 그 가운데 worktree 부분만 본다.

`sessions.checkpoint_revision`과 같은 행은 `pointer`로 표시된다. pointer가 가리키는 revision에 `checkpoints` 행이 없으면 그 자체로 FAIL이다. manifest의 `sessionId`·`revision`도 행과 같아야 한다.

그다음 scratch key에 `If-None-Match: *` 두 번째 쓰기가 412로 거부되는지 확인한다. 복원된 store가 여전히 create-only인지 보는 것이다. scratch key의 version과 delete marker는 확인 뒤 모두 version id로 지운다. 하나라도 남으면 FAIL이다.

마지막으로 `checkpoint-pins-cli.ts plans`가 복원본의 API가 할 일을 그대로 한다.

- `describeBucketProtection` 결과를 출력하고 API의 `locked` 기동 검사(`assertCheckpointBucketProtection`)와 bucket 기본 암호화 검사(`assertCheckpointBucketEncryption`, SSE-S3)를 통과하는지 본다. `repin`도 객체를 쓰기 전에 같은 암호화 검사를 한다.
- pointer마다 production 배선(`createApiCheckpointService` + Postgres store, `locked`)의 `getRestorePlan`이 `ready`인지 본다. `--image`가 있으면 그 이미지의 worker가 묻는 runtime으로 묻는다. 먼저 pointer마다 API가 줄 claim의 digest 입력(`principal`=`sessions.owner_id`, `runtime_config`=복원본 DB의 세션 spec(`sessions.spec_source`))을 다시 만든다. 세션의 연결이 꺼졌거나, 모델이 연결 목록에서 빠졌거나, 저장소(`repository_id`·`repo_url`·`branch`)를 카탈로그가 더 이상 그대로 갖지 않으면 실제 claim도 이 세션을 받지 않으므로 `FAIL <session>@<rev> plan: no claim for the target image: …`다. 그다음 `docker run --rm -i --network none --entrypoint bun <image> run apps/worker/src/image-runtime.ts`에 claim을 stdin으로 넣어, 이미지 코드의 `CLAUDE_RUNTIME_FINGERPRINT`(engine·SDK·CLI 버전)와 그 이미지가 claim으로 계산한 런타임 설정 digest(`profileSha256`)를 받는다. 복원은 manifest의 값과 이 값이 모두 같아야 하므로, 다른 버전으로 봉인되었거나 digest 계산 방식이 바뀐 이미지 앞의 pointer는 `FAIL <session>@<rev> plan: incompatible with the target image (checkpoint → image): cliVersion 2.1.270 → …`(또는 `profileSha256 … → …`)가 된다. 이미지에는 이 값을 담은 label이 없어서 이미지를 직접 실행한다. `image-runtime.ts`가 없는 이미지는 읽지 못하므로 검사 전체가 멈춘다. `--image`가 없으면 manifest 자신의 runtime으로 묻고 `SKIP restore plans against the worker image …`를 출력한다. 이 경우 이미지가 달라도 `ready`가 나온다.
- `--image`와 함께 `--record`를 주면 살아 있는 체크포인트마다 `checkpoint_restore_check`에 결과(`ok`·`mismatch`·`error`)를 한 줄씩 남긴다. pointer가 가리키는 체크포인트는 위의 복원 계획으로 판정하고, 나머지(되돌아갈 때 쓰는 이전 체크포인트)는 봉인된 digest가 이미지가 그 세션에 대해 내놓는 digest 중 하나인지로 판정한다. 기록은 읽은 manifest의 sha256과 이미지의 content id에 묶인다. 다른 엔진 빌드로 봉인된 체크포인트는 `SKIP`으로 남기고 기록하지 않으므로, 그 빌드의 이미지로 한 번 더 돌려야 한다. 이미지를 걷어내기 전에는 남길 워커 이미지의 content id 목록으로 `SELECT assert_checkpoint_restore_verified(ARRAY[...])`를 불러, 살아 있는 체크포인트 중 그 이미지들의 최신 기록이 없거나 모두 `ok`가 아닌 것이 하나라도 있으면 멈춘다. 없앨 이미지가 남긴 기록은 세지 않는다. 함수는 호출한 트랜잭션이 끝날 때까지 `checkpoints` 쓰기를 막으므로, 검증과 삭제는 같은 트랜잭션에서 해야 한다. 이미지는 `restorableSchemes`에 적은 이전 digest scheme(`profileDigestScheme` 2 이미지는 1과 2)의 체크포인트를 같은 방식으로 복원 후보에 올린다.
- plan의 manifest와 모든 object를 plan이 가리키는 version으로 읽고, hold가 걸려 있는지 본다.
- `session_event_archives` 행마다 object를 `version_id`로 읽어 크기와 sha256을 대조하고, 그 version에 hold가 걸려 있는지 본다(`PASS archive <session>@<from id>: read back and held`).

하나라도 실패하면 exit 5.

두 항목은 복원된 저장소만으로는 볼 수 없어 이 스크립트에서는 `SKIP`으로 출력한다. 둘 다 스택을 실제로 띄워야 하므로 `tests/e2e/restore-resume.sh`가 확인한다(아래 "실스택에서 복원 뒤 재개 확인").

- **resume이 같은 native session으로 이어짐** — 새 worker가 복원한 checkpoint에서 같은 Claude session을 이어 가는지 본다.
- **worker image digest** — `manifest.json`의 `images.worker`가 checkpoint를 만든 worker의 image와 같은지 본다.

## checkpoint 객체의 version: 복원 뒤 재고정

checkpoint manifest와 pointer는 S3 object **version**을 가리킨다. 복원된 bucket에서는 모든 객체가 새 VersionId를 받으므로, 백업 시점의 version을 그대로 가리키는 manifest는 복원본에서 읽을 수 없다.

**선택: 복원 뒤 재고정(re-pin).** VersionId를 유지하는 replication은 쓰지 않는다. 근거는 다음과 같다.

- S3와 로컬 S3의 VersionId는 저장소가 정한다. PutObject로 지정할 수 없다.
- VersionId를 유지하며 복사하는 것은 S3 Replication(SRR/CRR, Batch Replication)뿐이다. 이것은 살아 있는 원본 bucket에서 다른 bucket으로 가는 복제다.
- 이 백업은 디렉터리이므로 원래 id를 되살릴 방법이 없다. 실제 AWS에서 replication을 운영하는 절차는 이 문서의 범위 밖이다.

재고정은 다음 규칙을 지킨다. Codex와 합의했다.

- **key는 그대로 둔다.** manifest는 원래 key(`manifestRefFor(session, revision, attempt)`)에 다시 쓴다. 복원 sync가 그 key를 뺐으므로 새 bucket에서는 이것이 첫 create-only 쓰기다. 그래서 finalize의 key 규칙과 `putImmutable` 규칙이 그대로 성립한다.
- **바뀌는 것은 version과 manifest digest다.** manifest 안 각 object ref(transcript part, bundle, base bundle, untracked, 저장된 outputs)의 `version` 필드만 바뀐다. 크기 제한으로 생략된 output은 object ref가 없으므로 그대로 둔다. 한 key는 복원 bucket에서 version 하나만 가지므로, 뒤 revision의 `baseBundles`는 앞 revision의 `workspace.bundle`과 같은 새 version을 가리킨다. 그래서 복원된 pointer 위에서 다음 finalize가 요구하는 사슬 일치(`baseBundles` = 앞 checkpoint의 사슬)도 그대로 성립한다. 최상위 schema `version`(2)은 그대로다. transcript part-list digest(`digestParts`)는 version을 덮지 않으므로 그대로 유효하다. 행의 `manifest_sha256`·`manifest_version`은 새 값이 된다.
- **`versions_held=true`는 모든 검증을 마친 뒤에만 쓴다.** 재고정 도구는 DB와 bucket 권한을 모두 가진 신뢰된 발급자다. locked finalize와 똑같이 모든 version을 version 단위로 해시하고 hold를 건 뒤에만 true로 둔다. false로 남기면 `getRestorePlan`이 이 값을 올리지 않으므로, 매 복원마다 transcript 전체를 다시 해시하게 된다.
- **`turns.result_json`의 finalize digest는 원래 요청 그대로 둔다.** 원래 요청의 replay는 계속 맞고, 재고정한 필드로 온 요청은 충돌한다. 복원본에는 원래 worker가 없으므로 실제로 오는 요청은 없다.
- **백업 원본은 바뀌지 않는다.** `objects/`의 manifest는 원래 바이트 그대로 남는다.

재고정 뒤 복원본의 API는 기본값 `locked`로 뜬다. `unversioned`는 versioning이 꺼진 bucket에서만 쓴다.

## 실스택에서 복원 뒤 재개 확인

```bash
tests/e2e/restore-resume.sh    # macOS: PATH="/bin:/usr/bin:$PATH" bash tests/e2e/restore-resume.sh
```

`tests/e2e/run.sh`와 같은 이미지·overlay로 제품 스택(`apps` profile)을 띄워 다음을 한 번에 끝까지 수행한다. 기록은 `RR_OUT`(기본값은 새 임시 디렉터리)에 남는다. 기록에는 tested SHA, image id, SDK·Claude Code 버전, 단계별 JSON, 두 project의 checkpoint 행과 manifest, restore·verify 로그, compose 로그, worker 로그, 대조표가 들어간다. backup 디렉터리는 API key 해시를 담으므로 `manifest.json`만 남기고 지운다.

1. 원본 project에서 세션을 만들고 turn 2개를 실제 Claude Code로 돌린다. turn 1은 `echo alpha | tee hello.txt`, turn 2는 `echo beta | tee -a hello.txt`이다. 그다음 pause로 checkpoint를 커밋하고 worker를 내린다.
2. api·scheduler·reconciler·maintenance를 멈추고 `scripts/backup.sh`를 뜬다. 그다음 원본 project와 그 installation 라벨이 붙은 container·network·volume(worker workspace volume 포함)을 모두 지운다. 세션을 넘기는 것은 backup뿐이다.
3. `scripts/restore.sh`로 새 project에 복원하고 `scripts/verify-restore.sh`를 돈다. 그 위에 restore override를 겹친 채 같은 이미지로 apps를 띄운다. 이때 restore가 띄운 localstack이 다시 만들어지면 실패로 친다. 로컬 S3는 named volume으로 보존되지만 앱 시작이 저장소를 불필요하게 다시 만드는지 확인하는 회귀 검사다.
4. 원본에서 발급한 API key로 공개 API의 `resume`를 부른다. key 해시도 복원된 DB에 있다. 새 worker가 checkpoint를 복원하고 ready를 보고하면 turn 3(`cat hello.txt`)을 보낸다.
5. 대조한다.
   - turn 3이 `alpha\nbeta`를 한 번씩만 읽는다. 입력이 다시 실행됐다면 beta가 둘이 되고, workspace가 복원되지 않았다면 파일이 없다.
   - 복원본의 fake Messages API는 새 prompt(`rr3`)만 받는다. 그 요청의 history에는 `rr1`, `rr2`, `rr3`가 순서대로 있다. 엔진이 새 대화를 연 것이 아니라 이전 대화를 이어 갔다는 뜻이다.
   - turn 3 뒤 새 checkpoint의 manifest를 원본 manifest와 대조한다. 다음이 모두 같아야 한다.
     - engine session id(`resume`)
     - transcript part(key·sha256)가 앞부분으로 그대로 이어지는지. 새 part는 다음 generation 아래에 붙는다.
     - workspace commit과 untracked 파일의 sha256
   - worker 로그의 `worker.checkpoint.restored`가 원본 revision과 commit을 가리킨다.
   - `manifest.json`의 `images.worker`가 원본 worker 컨테이너의 image와 같고, 복원본 worker의 image와도 같다.

knob: `RR_PROJECT`(원본 project 이름, 복원 project는 `<이름>r`), `RR_INSTALLATION_ID`(두 쪽 공용 `EXECUTION_INSTALLATION_ID`), `RR_PORT_BASE`(복원 project의 loopback 포트 4개, 기본값 24320), `RR_KEEP=1`(스택·이미지·backup을 남김), `RR_IMAGES_FROM=<project>`(아무것도 빌드하지 않고 그 project가 이미 가진 이미지를 두 project에 다시 tag해서 쓴다. `scripts/soak/stack.sh`나 `scripts/d2-gate/run.sh`가 띄운 스택의 이미지로 release candidate를 그대로 확인할 때 쓴다. 두 project 이름과 달라야 한다). 두 project와 installation 라벨 자원이 이미 있으면 아무것도 지우지 않고 멈춘다.

engine session id는 manifest의 `resume`에만 있다. `sessions.claude_session_id` 컬럼은 아무 코드도 쓰지 않는다.

## 로컬에서 끝까지 돌려 보기

위 e2e는 worker가 실제로 커밋한 checkpoint로 돈다. 세션을 돌리지 않은 설치에서 스크립트만 시험할 때는 `scripts/dev/seed-checkpoint.ts`를 쓴다. 이 스크립트는 워커와 같은 계약으로 세션 하나와 커밋된 checkpoint 하나를 어느 설치에든 심는다. 이 checkpoint는 locked finalize가 남기는 모양이다. 모든 ref와 `manifest_version`이 version을 싣고, 모든 version에 hold가 걸려 있으며, `versions_held=true`다. 그래서 bucket은 versioning과 Object Lock이 켜져 있어야 한다(compose 기본값).

```bash
# 1. 원본 설치(예: werft 프로젝트)에 fixture 심기
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
bun run scripts/dev/seed-checkpoint.ts

# 2. 백업 → 복원 → 검증. writer(api·scheduler·reconciler·maintenance)가 돌면 backup이 거부한다
docker compose stop api scheduler reconciler maintenance
docker ps --filter label=werft.installation --format '{{.Names}}'   # scheduler가 띄운 worker. 남아 있으면 docker stop <이름>
dir=$(scripts/backup.sh --project werft)
scripts/restore.sh "$dir" --into ap-restore-1 --port-base 25432
scripts/verify-restore.sh --project ap-restore-1   # 마지막 줄들: bucket PASS, "<session>@<rev> plan: ready under locked"

# 3. (선택) 실제 API 프로세스를 복원본 위에 locked로 띄워 /readyz 200 확인
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:25432/sessions AUTH_MODE=api-key PORT=27999 \
AWS_ENDPOINT_URL=http://127.0.0.1:25433 AWS_REGION=ap-northeast-1 S3_BUCKET=claude-sessions \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
CHECKPOINT_OBJECT_PROTECTION=locked bun apps/control-host/src/api/server.ts   # + 위와 같은 AWS 자격 증명

# 4. 정리 (복원본만. --rmi local은 복원이 빌드한 이미지)
docker compose -p ap-restore-1 -f infra/compose.yml down -v --rmi local
docker compose start api scheduler reconciler maintenance   # 원본을 다시 연다
```

`tests/backup-restore.test.ts`는 docker 없이 다음을 검사한다: schema 게이트와 SHA256SUMS 게이트, verify-restore의 bundle 사슬 적용(`unbundle_chain`), 가짜 S3 HTTP 서버에 대한 `--object-store env` 복원 대상 거부(원본 bucket 이름, version·delete marker가 있는 bucket, Object Lock이 없는 bucket, 쓰기 요청 0건), `objects/` 밖을 가리키는 key 거부, 가짜 `docker`에 대한 writer 가동 중 백업 거부와 실패한 백업의 `.failed` 이름. `tests/checkpoint-pins.test.ts`는 in-memory versioned store로 capture·재고정과 그 거부 경로(base bundle 사슬 포함), 재고정한 checkpoint의 locked `getRestorePlan`, `--image`가 엔진 build나 profile digest 계산만 바뀐 이미지를 incompatible로, 봉인한 이미지를 ready로 판정하는지를 검사하며 `bun run test`에 포함된다.
