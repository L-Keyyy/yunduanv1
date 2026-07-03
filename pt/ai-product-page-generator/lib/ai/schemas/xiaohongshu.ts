import { z } from "zod";

export const xiaohongshuPageSchema = z.object({
  pageNumber: z.number().int().min(1),
  title: z.string().min(1),
  subtitle: z.string().default(""),
  body: z.string().min(1),
  visualDirection: z.string().min(1),
  layout: z.string().min(1),
  imagePrompt: z.string().default(""),
  negativePrompt: z.string().default(""),
});

export const xiaohongshuPlanSchema = z.object({
  topic: z.string().min(1),
  audience: z.string().min(1),
  coreInsight: z.string().min(1),
  titleOptions: z.array(z.string().min(1)).min(3).max(8),
  coverTitle: z.string().min(1),
  coverSubtitle: z.string().default(""),
  pages: z.array(xiaohongshuPageSchema).min(5).max(8),
  caption: z.string().min(1),
  hashtags: z.array(z.string().min(1)).min(5).max(12),
  exportNote: z.string().default(""),
});

export type XiaohongshuPlan = z.infer<typeof xiaohongshuPlanSchema>;
