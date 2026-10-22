/** Actual proposal milestones, shared by CLI services and Studio. */
export type ProposalStage = 'check' | 'upload' | 'sign' | 'relay' | 'source' | 'verify';
export type ProposalProgress = (stage: ProposalStage, detail: string) => void | Promise<void>;
