import type { ToolDefinition } from "./types";

/**
 * Реестр AI-инструментов платформы (PLAN.md, раздел 1 и 8).
 * Дефолтные промпты — черновые отправные точки, пользователь может их
 * менять/дополнять на вкладке "Промпты" каждого инструмента (prompt_template).
 */
export const TOOLS: ToolDefinition[] = [
  {
    key: "business-requirements",
    name: "Бизнес-требования",
    description: "Ускоряет подготовку бизнес-требований по фиче на основе контекста проекта.",
    stageOrder: 1,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [
      {
        name: "Черновик бизнес-требований",
        content:
          "Ты помогаешь аналитику подготовить бизнес-требования к новой фиче.\n" +
          "На основе описания фичи и контекста проекта (загруженной документации) сформулируй:\n" +
          "1) проблему и цель, 2) целевую аудиторию, 3) ключевые бизнес-сценарии, " +
          "4) критерии успеха, 5) вне скоупа.\n\nОписание фичи: {{feature_description}}\n\nКонтекст проекта: {{project_context}}",
      },
    ],
  },
  {
    key: "system-analysis",
    name: "Системный анализ / проектирование",
    description: "Помогает проектировать решение и писать системный анализ по фиче.",
    stageOrder: 2,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [
      {
        name: "Черновик системного анализа",
        content:
          "Ты выступаешь системным аналитиком. На основе бизнес-требований и контекста проекта " +
          "(существующая архитектура, документация) предложи техническое решение: " +
          "затрагиваемые компоненты, изменения контрактов/API, риски и открытые вопросы.\n\n" +
          "Бизнес-требования: {{business_requirements}}\n\nКонтекст проекта: {{project_context}}",
      },
    ],
  },
  {
    key: "design",
    name: "Дизайн",
    description: "Ускоряет подготовку дизайна по фиче.",
    stageOrder: 3,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [],
  },
  {
    key: "autocoding",
    name: "Написание кода",
    description: "Пишет код по системному анализу без участия разработчика на этом шаге.",
    stageOrder: 4,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [],
  },
  {
    key: "code-review",
    name: "Код-ревью",
    description: "Проводит код-ревью изменений. Уже есть рабочая реализация — предстоит интеграция.",
    stageOrder: 5,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [
      {
        name: "Базовое код-ревью",
        content:
          "Проведи код-ревью diff'а ниже. Проверь корректность, безопасность, производительность, " +
          "граничные случаи и соответствие описанному системному анализу (если он есть в контексте). " +
          "Дай список замечаний с указанием файла/строки и серьёзности.\n\nDiff: {{diff}}\n\nКонтекст проекта: {{project_context}}",
      },
    ],
  },
  {
    key: "testing",
    name: "Автотесты",
    description: "Повышает качество и покрытие автотестами.",
    stageOrder: 6,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [],
  },
];

export function getTool(key: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.key === key);
}
