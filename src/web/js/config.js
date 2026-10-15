// 현장·개발 환경에 따라 바꿀 수 있는 값

export const config = Object.freeze({
  // 미리보기 좌우 반전 (거울). 반전은 웹에서만 하고 OBS에서는 하지 않는다.
  mirror: true,

  // 화면·사진 비율 (가로:세로)
  aspectRatio: Object.freeze({ width: 9, height: 16 }),

  // 이 문자열이 라벨에 포함된 카메라를 우선 사용한다 (대소문자 무시). 없으면 기본 카메라.
  preferredCameraLabel: 'OBS Virtual Camera',

  // 카메라 해상도 권장값 (ideal, 강제 아님). 장치가 지원하는 범위에서 가장 가까운 값을 받는다.
  // 현장 최대(4K 세로)로 두어 OBS 출력(FHD~4K 세로)을 그대로 받고, 낮은 기본값으로 떨어지는 것을 막는다.
  idealResolution: Object.freeze({ width: 2160, height: 3840 }),

  // 카메라 준비·끊김·회복 시간 (단위 ms, 사용자 확정 2026-10-15)
  cameraRecovery: Object.freeze({
    retryIntervalMs: 3000, // 실패·끊김 뒤 다시 시도하는 간격
    firstFrameTimeoutMs: 5000, // 스트림을 얻은 뒤 첫 프레임을 기다리는 시간
    stallTimeoutMs: 3000, // 새 프레임이 이 시간 동안 없으면 끊김으로 본다
    staffNoticeMs: 30000, // 준비되지 않은 상태가 이 시간 이상 이어지면 직원 문의 문구로 바꾼다
  }),
});
