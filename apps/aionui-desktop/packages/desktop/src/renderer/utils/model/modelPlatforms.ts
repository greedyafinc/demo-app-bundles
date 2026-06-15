/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 模型平台配置模块
 * Model Platform Configuration Module
 *
 * 集中管理所有模型平台的配置信息，便于扩展和维护
 * Centralized management of all model platform configurations for extensibility and maintainability
 */

import { resolveBackendAssetUrl } from '@/renderer/utils/platform';

const buildLogoAssetUrl = (path: string): string => {
  return resolveBackendAssetUrl(`/api/assets/logos/${path}`) ?? `/api/assets/logos/${path}`;
};

/**
 * UnifiedAI 平台标识与图标
 * UnifiedAI platform value + self-contained logo (hub-and-spokes mark).
 * Inline data URI so it renders without the backend asset route.
 */
export const UNIFIED_PLATFORM_VALUE = 'unified';

export const UNIFIED_LOGO_DATA_URI =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236C5CE7' stroke-width='1.7' stroke-linecap='round'><circle cx='12' cy='12' r='3.4'/><path d='M12 8.6V5.4M12 18.6v-3.2M8.6 12H5.4M18.6 12h-3.2M9.6 9.6 7.4 7.4M16.6 16.6l-2.2-2.2M14.4 9.6l2.2-2.2M7.4 16.6l2.2-2.2'/><circle cx='12' cy='4' r='1.1'/><circle cx='12' cy='20' r='1.1'/><circle cx='4' cy='12' r='1.1'/><circle cx='20' cy='12' r='1.1'/><circle cx='6.3' cy='6.3' r='1.1'/><circle cx='17.7' cy='17.7' r='1.1'/><circle cx='17.7' cy='6.3' r='1.1'/><circle cx='6.3' cy='17.7' r='1.1'/></svg>";

/**
 * 平台类型
 * Platform type
 */
export type PlatformType = 'gemini' | 'gemini-vertex-ai' | 'anthropic' | 'custom' | 'new-api' | 'bedrock';

/**
 * 模型平台配置接口
 * Model Platform Configuration Interface
 */
export interface PlatformConfig {
  /** 平台名称 / Platform name */
  name: string;
  /** 平台值（用于表单） / Platform value (for form) */
  value: string;
  /** Logo 路径 / Logo path */
  logo: string | null;
  /** 平台标识 / Platform identifier */
  platform: PlatformType;
  /** Base URL（预设供应商使用） / Base URL (for preset providers) */
  base_url?: string;
  /** 国际化 key（可选，用于需要翻译的平台名称） / i18n key (optional, for platform names that need translation) */
  i18nKey?: string;
}

/**
 * 模型平台选项列表
 * Model Platform options list
 *
 * 顺序：
 * 1. Gemini (官方)
 * 2. Gemini Vertex AI
 * 3. 自定义（需要用户输入 base url）
 * 4+ 预设供应商
 */
export const MODEL_PLATFORMS: PlatformConfig[] = [
  // UnifiedAI — OAuth sign-in, no API key; base_url/api_key are filled from the
  // main process (loopback gateway proxy) after sign-in. Speaks the OpenAI
  // protocol end to end, hence platform: 'custom'.
  {
    name: 'UnifiedAI',
    value: UNIFIED_PLATFORM_VALUE,
    logo: UNIFIED_LOGO_DATA_URI,
    platform: 'custom',
  },

  // 自定义选项（需要用户输入 base url）/ Custom option (requires user to input base url)
  { name: 'Custom', value: 'custom', logo: null, platform: 'custom', i18nKey: 'settings.platformCustom' },

  // New API 多模型网关 / New API multi-model gateway
  {
    name: 'New API',
    value: 'new-api',
    logo: buildLogoAssetUrl('ai-cloud/newapi.svg'),
    platform: 'new-api',
    i18nKey: 'settings.platformNewApi',
  },

  // 官方 Gemini 平台
  {
    name: 'Gemini',
    value: 'gemini',
    logo: buildLogoAssetUrl('ai-major/gemini.svg'),
    platform: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com',
  },
  {
    name: 'Gemini (Vertex AI)',
    value: 'gemini-vertex-ai',
    logo: buildLogoAssetUrl('ai-major/gemini.svg'),
    platform: 'gemini-vertex-ai',
  },

  // 预设供应商（按字母顺序排列）
  {
    name: 'OpenAI',
    value: 'OpenAI',
    logo: buildLogoAssetUrl('ai-major/openai.svg'),
    platform: 'custom',
    base_url: 'https://api.openai.com/v1',
  },
  {
    name: 'Anthropic',
    value: 'Anthropic',
    logo: buildLogoAssetUrl('ai-major/anthropic.svg'),
    platform: 'anthropic',
    base_url: 'https://api.anthropic.com',
  },
  {
    name: 'AWS Bedrock',
    value: 'AWS-Bedrock',
    logo: buildLogoAssetUrl('ai-cloud/bedrock.svg'),
    platform: 'bedrock',
    i18nKey: 'settings.platformBedrock',
  },
  {
    name: 'DeepSeek',
    value: 'DeepSeek',
    logo: buildLogoAssetUrl('ai-major/deepseek.svg'),
    platform: 'custom',
    base_url: 'https://api.deepseek.com/v1',
  },
  {
    name: 'MiniMax',
    value: 'MiniMax',
    logo: buildLogoAssetUrl('ai-china/minimax.png'),
    platform: 'custom',
    base_url: 'https://api.minimaxi.com/v1',
  },
  {
    name: 'Novita',
    value: 'Novita',
    logo: buildLogoAssetUrl('ai-cloud/novita.svg'),
    platform: 'custom',
    base_url: 'https://api.novita.ai/openai/v1',
  },
  {
    name: 'OpenRouter',
    value: 'OpenRouter',
    logo: buildLogoAssetUrl('ai-cloud/openrouter.svg'),
    platform: 'custom',
    base_url: 'https://openrouter.ai/api/v1',
  },
  {
    name: 'Dashscope',
    value: 'Dashscope',
    logo: buildLogoAssetUrl('ai-china/qwen.svg'),
    platform: 'custom',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    name: 'Dashscope Coding Plan',
    value: 'Dashscope-Coding',
    logo: buildLogoAssetUrl('ai-china/qwen.svg'),
    platform: 'custom',
    base_url: 'https://coding.dashscope.aliyuncs.com/v1',
  },
  {
    name: 'SiliconFlow-CN',
    value: 'SiliconFlow-CN',
    logo: buildLogoAssetUrl('ai-cloud/siliconflow.png'),
    platform: 'custom',
    base_url: 'https://api.siliconflow.cn/v1',
  },
  {
    name: 'SiliconFlow',
    value: 'SiliconFlow',
    logo: buildLogoAssetUrl('ai-cloud/siliconflow.png'),
    platform: 'custom',
    base_url: 'https://api.siliconflow.com/v1',
  },
  {
    name: 'Zhipu',
    value: 'Zhipu',
    logo: buildLogoAssetUrl('ai-china/zhipu.svg'),
    platform: 'custom',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    name: 'Moonshot (China)',
    value: 'Moonshot',
    logo: buildLogoAssetUrl('ai-china/kimi.svg'),
    platform: 'custom',
    base_url: 'https://api.moonshot.cn/v1',
  },
  {
    name: 'Moonshot (Global)',
    value: 'Moonshot-Global',
    logo: buildLogoAssetUrl('ai-china/kimi.svg'),
    platform: 'custom',
    base_url: 'https://api.moonshot.ai/v1',
  },
  {
    name: 'xAI',
    value: 'xAI',
    logo: buildLogoAssetUrl('ai-major/xai.svg'),
    platform: 'custom',
    base_url: 'https://api.x.ai/v1',
  },
  {
    name: 'Ark',
    value: 'Ark',
    logo: buildLogoAssetUrl('ai-china/volcengine.svg'),
    platform: 'custom',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  {
    name: 'Qianfan',
    value: 'Qianfan',
    logo: buildLogoAssetUrl('ai-china/baidu.svg'),
    platform: 'custom',
    base_url: 'https://qianfan.baidubce.com/v2',
  },
  {
    name: 'Hunyuan',
    value: 'Hunyuan',
    logo: buildLogoAssetUrl('ai-china/tencent.svg'),
    platform: 'custom',
    base_url: 'https://api.hunyuan.cloud.tencent.com/v1',
  },
  {
    name: 'Lingyi',
    value: 'Lingyi',
    logo: buildLogoAssetUrl('ai-china/lingyiwanwu.svg'),
    platform: 'custom',
    base_url: 'https://api.lingyiwanwu.com/v1',
  },
  {
    name: 'Poe',
    value: 'Poe',
    logo: buildLogoAssetUrl('ai-cloud/poe.svg'),
    platform: 'custom',
    base_url: 'https://api.poe.com/v1',
  },
  {
    name: 'PPIO',
    value: 'PPIO',
    logo: buildLogoAssetUrl('ai-cloud/ppio.svg'),
    platform: 'custom',
    base_url: 'https://api.ppinfra.com/v3/openai',
  },
  {
    name: 'ModelScope',
    value: 'ModelScope',
    logo: buildLogoAssetUrl('ai-cloud/modelscope.svg'),
    platform: 'custom',
    base_url: 'https://api-inference.modelscope.cn/v1',
  },
  {
    name: 'InfiniAI',
    value: 'InfiniAI',
    logo: buildLogoAssetUrl('ai-cloud/infiniai.svg'),
    platform: 'custom',
    base_url: 'https://cloud.infini-ai.com/maas/v1',
  },
  {
    name: 'Ctyun',
    value: 'Ctyun',
    logo: buildLogoAssetUrl('ai-cloud/ctyun.svg'),
    platform: 'custom',
    base_url: 'https://wishub-x1.ctyun.cn/v1',
  },
  {
    name: 'StepFun',
    value: 'StepFun',
    logo: buildLogoAssetUrl('ai-china/stepfun.svg'),
    platform: 'custom',
    base_url: 'https://api.stepfun.com/v1',
  },
];

/**
 * New API 协议选项
 * New API protocol options for per-model protocol configuration
 */
export const NEW_API_PROTOCOL_OPTIONS = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Gemini', value: 'gemini' },
  { label: 'Anthropic', value: 'anthropic' },
];

/**
 * 根据模型名称自动推断 New API 协议类型
 * Auto-detect New API protocol type based on model name
 */
export const detectNewApiProtocol = (modelName: string): string => {
  const name = modelName.toLowerCase();
  if (name.startsWith('claude') || name.startsWith('anthropic')) return 'anthropic';
  if (name.startsWith('gemini') || name.startsWith('models/gemini')) return 'gemini';
  // Default to openai (covers gpt, deepseek, qwen, o1, o3, etc.)
  return 'openai';
};

// ============ 工具函数 / Utility Functions ============

/**
 * 根据 value 获取平台配置
 * Get platform config by value
 */
export const getPlatformByValue = (value: string): PlatformConfig | undefined => {
  return MODEL_PLATFORMS.find((p) => p.value === value);
};

/**
 * 获取所有预设供应商（有 base_url 的）
 * Get all preset providers (with base_url)
 */
export const getPresetProviders = (): PlatformConfig[] => {
  return MODEL_PLATFORMS.filter((p) => p.base_url);
};

export const getProviderLogo = ({
  name,
  base_url,
  platform,
}: {
  name?: string;
  base_url?: string;
  platform?: string;
}): string | null => {
  if (!name && !base_url && !platform) return null;

  if (platform) {
    const byPlatform = MODEL_PLATFORMS.find((item) => item.platform === platform && item.logo);
    if (byPlatform?.logo) return byPlatform.logo;
  }

  if (name) {
    const byName = MODEL_PLATFORMS.find((item) => item.name === name && item.logo);
    if (byName?.logo) return byName.logo;

    const lowerName = name.toLowerCase();
    const byLowerName = MODEL_PLATFORMS.find((item) => item.name.toLowerCase() === lowerName && item.logo);
    if (byLowerName?.logo) return byLowerName.logo;
  }

  if (base_url) {
    const byUrl = MODEL_PLATFORMS.find((item) => {
      if (!item.base_url || !item.logo) return false;
      try {
        return base_url.includes(new URL(item.base_url).hostname);
      } catch {
        return false;
      }
    });
    if (byUrl?.logo) return byUrl.logo;
  }

  return null;
};

/**
 * 获取官方 Gemini 平台
 * Get official Gemini platforms
 */
export const getGeminiPlatforms = (): PlatformConfig[] => {
  return MODEL_PLATFORMS.filter((p) => p.platform === 'gemini' || p.platform === 'gemini-vertex-ai');
};

/**
 * 检查平台是否为 Gemini 类型
 * Check if platform is Gemini type
 */
export const isGeminiPlatform = (platform: PlatformType): boolean => {
  return platform === 'gemini' || platform === 'gemini-vertex-ai';
};

/**
 * 检查是否为自定义选项（无预设 base_url）
 * Check if it's custom option (no preset base_url)
 */
export const isCustomOption = (value: string): boolean => {
  const platform = getPlatformByValue(value);
  return value === 'custom' && !platform?.base_url;
};

/**
 * 检查是否为 UnifiedAI 选项（OAuth 登录，无需 API Key）
 * Check if it's the UnifiedAI option (OAuth sign-in, no API key)
 */
export const isUnifiedOption = (value: string): boolean => {
  return value === UNIFIED_PLATFORM_VALUE;
};

// Re-export from common for renderer convenience
export { isNewApiPlatform } from '@/common/utils/platformConstants';

/**
 * 根据名称搜索平台（不区分大小写）
 * Search platforms by name (case-insensitive)
 */
export const searchPlatformsByName = (keyword: string): PlatformConfig[] => {
  const lowerKeyword = keyword.toLowerCase();
  return MODEL_PLATFORMS.filter((p) => p.name.toLowerCase().includes(lowerKeyword));
};
