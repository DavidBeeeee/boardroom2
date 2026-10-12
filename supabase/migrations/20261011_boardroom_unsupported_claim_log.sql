-- WO-20261011-evening (WBR-373, Developer 45): AI Boardroom invented-progress guard.
--
-- boardroom_logs gains an "unsupported_claim" event type, written when a work
-- card or workspace memory write claimed a completed step, outcome or number
-- the member never reported, and the claim was rewritten as a proposal. The
-- row carries counts only, never the member's words or the claim text.

alter table public.boardroom_logs drop constraint if exists boardroom_logs_event_type_check;
alter table public.boardroom_logs add constraint boardroom_logs_event_type_check
  check (event_type = any (array['turn'::text, 'deepseek_call'::text, 'state_write'::text, 'safety'::text, 'unsupported_claim'::text]));
