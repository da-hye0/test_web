#!/usr/bin/env bash
# GitHub Actions가 키 없이 Cloud Run에 배포할 수 있게 한 번만 준비한다 (Workload Identity Federation)
#   1) 배포 전용 서비스 계정 github-deployer 와 필요한 권한
#   2) GitHub OIDC를 믿는 Workload Identity 풀/공급자 (da-hye0/test_web 저장소만 허용)
#   3) 그 저장소의 워크플로가 github-deployer 로 행동할 수 있게 연결
# 여러 번 실행해도 이미 있는 것은 건너뛴다.
set -euo pipefail

PROJECT_ID=project-d813a5b1-563c-4745-80a
PROJECT_NUMBER=731281123801
REPO=da-hye0/test_web
SA_NAME=github-deployer
SA="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
RUNTIME_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"  # Cloud Run 서비스가 쓰는 계정
POOL=github
PROVIDER=github-oidc

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT_ID"

gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" --display-name "GitHub Actions 배포 (matjip)"

# 소스 배포(--source)에 필요한 권한: Cloud Run, Cloud Build, 이미지 저장소, 소스 버킷, 빌드 로그
for role in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.writer \
            roles/storage.admin roles/serviceusage.serviceUsageConsumer roles/logging.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" \
    --condition=None --quiet >/dev/null
done
# 배포할 때 서비스의 실행 계정으로 행동할 수 있어야 한다
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project "$PROJECT_ID" \
  --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser --quiet >/dev/null

gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT_ID" --location global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT_ID" --location global \
    --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT_ID" --location global \
  --workload-identity-pool "$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT_ID" --location global \
    --workload-identity-pool "$POOL" --display-name "GitHub OIDC" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '$REPO'"

# 이 저장소에서 온 토큰만 github-deployer 로 바꿔 쓸 수 있다
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" \
  --quiet >/dev/null

echo "준비 끝. 이제 태그를 push 하면 배포돼요: git tag v1.0.0 && git push origin v1.0.0"
