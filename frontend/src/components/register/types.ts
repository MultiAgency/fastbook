export interface GenerateAction {
  enabled: boolean;
  loading: boolean;
  error?: string;
  onClick: () => void;
}
