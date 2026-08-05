import { useTranslation } from 'react-i18next';

/** 极简封装：返回 i18next 的 t 函数，默认命名空间为 'ui'。 */
export function useT() {
  const { t } = useTranslation('ui');
  return t;
}

export default useT;
