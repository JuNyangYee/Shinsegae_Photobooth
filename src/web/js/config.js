// 현장·개발 환경에 따라 바꿀 수 있는 값

export const config = Object.freeze({
  // 미리보기 좌우 반전 (거울). 반전은 웹에서만 하고 OBS에서는 하지 않는다.
  mirror: true,

  // 화면·사진 비율 (가로:세로)
  aspectRatio: Object.freeze({ width: 9, height: 16 }),

  // 이 문자열이 라벨에 포함된 카메라를 우선 사용한다 (대소문자 무시). 없으면 기본 카메라.
  preferredCameraLabel: 'OBS Virtual Camera',
});
