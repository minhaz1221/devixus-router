export type UsageEntry = {
  timestamp: string;
  original_model: string;
  routed_model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
};

export type DbSchema = {
  usage: UsageEntry[];
};

