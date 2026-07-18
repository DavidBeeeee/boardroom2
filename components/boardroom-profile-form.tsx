"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Save, UserRound } from "lucide-react";
import type { BoardroomProfile } from "@/lib/types";

export type BoardroomProfileDraft = Pick<BoardroomProfile,
  | "preferred_name"
  | "role_title"
  | "business_name"
  | "business_description"
  | "ideal_customer"
  | "offers"
  | "current_goals"
  | "constraints"
  | "additional_context"
>;

const EMPTY_PROFILE: BoardroomProfileDraft = {
  preferred_name: "",
  role_title: "",
  business_name: "",
  business_description: "",
  ideal_customer: "",
  offers: "",
  current_goals: "",
  constraints: "",
  additional_context: "",
};

type ProfileFormProps = {
  profile?: BoardroomProfile | null;
  onboarding?: boolean;
  onSave: (draft: BoardroomProfileDraft) => Promise<void>;
  onCancel?: () => void;
};

export function BoardroomProfileForm({ profile, onboarding = false, onSave, onCancel }: ProfileFormProps) {
  const [draft, setDraft] = useState<BoardroomProfileDraft>(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft({
      preferred_name: profile?.preferred_name || "",
      role_title: profile?.role_title || "",
      business_name: profile?.business_name || "",
      business_description: profile?.business_description || "",
      ideal_customer: profile?.ideal_customer || "",
      offers: profile?.offers || "",
      current_goals: profile?.current_goals || "",
      constraints: profile?.constraints || "",
      additional_context: profile?.additional_context || "",
    });
  }, [profile]);

  function update(key: keyof BoardroomProfileDraft, value: string) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.preferred_name.trim()) {
      setError("Tell the Boardroom what to call you.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Your profile could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass = "mt-1.5 w-full border border-stone-300 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-colors focus:border-teal dark:border-white/15 dark:bg-[#111716] dark:text-white";
  const labelClass = "block text-sm font-bold text-stone-800 dark:text-white";

  return (
    <form className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8" onSubmit={submit}>
      <header className="mb-8 border-b border-stone-300 pb-6 dark:border-white/15">
        <div className="mb-4 grid h-11 w-11 place-items-center bg-teal text-white"><UserRound size={22} /></div>
        <p className="text-xs font-bold uppercase tracking-widest text-teal">{onboarding ? "Private setup" : "My Profile"}</p>
        <h1 className="mt-1 font-serif text-3xl font-bold sm:text-4xl">{onboarding ? "Meet Your Boardroom" : "Your Boardroom Profile"}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500 dark:text-white/60">Start with the facts your team should know about you and your work. You can update this anytime.</p>
      </header>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelClass}>
          What should the team call you? <span className="text-coral">*</span>
          <input className={inputClass} value={draft.preferred_name} maxLength={80} onChange={event => update("preferred_name", event.target.value)} placeholder="Your preferred name" autoFocus={onboarding} />
        </label>
        <label className={labelClass}>
          Your role
          <input className={inputClass} value={draft.role_title} maxLength={120} onChange={event => update("role_title", event.target.value)} placeholder="Founder, coach, creator, consultant" />
        </label>
        <label className={labelClass}>
          Business or project name
          <input className={inputClass} value={draft.business_name} maxLength={160} onChange={event => update("business_name", event.target.value)} placeholder="The name you use publicly" />
        </label>
        <label className={labelClass}>
          Who do you help?
          <textarea className={`${inputClass} min-h-24 resize-y`} value={draft.ideal_customer} maxLength={1200} onChange={event => update("ideal_customer", event.target.value)} placeholder="The people you serve and what they need" />
        </label>
      </div>

      <div className="mt-5 grid gap-5">
        <label className={labelClass}>
          What are you building?
          <textarea className={`${inputClass} min-h-28 resize-y`} value={draft.business_description} maxLength={2000} onChange={event => update("business_description", event.target.value)} placeholder="Describe your business, project, or current direction" />
        </label>
        <label className={labelClass}>
          What do you offer?
          <textarea className={`${inputClass} min-h-24 resize-y`} value={draft.offers} maxLength={1600} onChange={event => update("offers", event.target.value)} placeholder="Products, services, prices, or ideas you are testing" />
        </label>
        <label className={labelClass}>
          What are your current goals?
          <textarea className={`${inputClass} min-h-24 resize-y`} value={draft.current_goals} maxLength={1600} onChange={event => update("current_goals", event.target.value)} placeholder="The outcomes that matter most right now" />
        </label>
        <label className={labelClass}>
          What constraints should the team understand?
          <textarea className={`${inputClass} min-h-24 resize-y`} value={draft.constraints} maxLength={1600} onChange={event => update("constraints", event.target.value)} placeholder="Time, money, capacity, responsibilities, deadlines, or hard limits" />
        </label>
        <label className={labelClass}>
          Anything else the team should always know?
          <textarea className={`${inputClass} min-h-24 resize-y`} value={draft.additional_context} maxLength={1600} onChange={event => update("additional_context", event.target.value)} placeholder="Background, preferences, important history, or standing context" />
        </label>
      </div>

      {error ? <p className="mt-5 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p> : null}

      <div className="mt-7 flex flex-wrap items-center justify-end gap-3 border-t border-stone-300 pt-5 dark:border-white/15">
        {!onboarding && onCancel ? (
          <button className="flex items-center gap-2 border border-stone-300 px-4 py-2.5 text-sm font-bold transition-colors hover:border-teal hover:text-teal dark:border-white/20" type="button" onClick={onCancel}>
            <ArrowLeft size={15} /> Cancel
          </button>
        ) : null}
        <button className="flex items-center gap-2 bg-coral px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50" type="submit" disabled={saving}>
          <Save size={15} /> {saving ? "Saving..." : onboarding ? "Enter the Boardroom" : "Save profile"}
        </button>
      </div>
    </form>
  );
}
