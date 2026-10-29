import type { AddressForm, Profile } from "@/lib/domain";

export type PublicProfile = {
  displayName: string;
  addressForm: AddressForm;
  dailyTime: string;
  timezone: string;
  proactiveEnabled: boolean;
  consented: boolean;
  subtitles: boolean;
  reducedHearing: boolean;
};

export function toPublicProfile(profile: Profile): PublicProfile {
  return {
    displayName: profile.displayName,
    addressForm: profile.addressForm,
    dailyTime: profile.dailyTime,
    timezone: profile.timezone,
    proactiveEnabled: profile.proactiveEnabled,
    consented: Boolean(profile.userConsentAt),
    subtitles: profile.subtitles,
    reducedHearing: profile.reducedHearing,
  };
}
