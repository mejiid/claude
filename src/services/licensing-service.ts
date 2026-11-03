import crypto from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/connection.js'
import { cloudTenants, cloudTenantLicenses, subscriptionPayments } from '../db/schema/index.js'
import { config } from '../config/index.js'

const SIGNING_SECRET = process.env.LICENSE_SIGNING_SECRET || 'pharmacy-saas-ed25519-public-signing-secret-v1'
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export interface SignedLicensePayload {
  tenantId: string
  businessName: string
  plan: 'trial' | 'standard' | 'enterprise'
  deviceFingerprint: string
  issuedAt: number
  validUntil: number
  graceUntil: number
  signature: string
}

export class CloudLicensingService {
  /**
   * Generates a readable activation code in the format PHARM-XXXX-YYYY.
   */
  static generateActivationKey(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let part1 = ''
    let part2 = ''
    for (let i = 0; i < 4; i++) {
      part1 += chars[Math.floor(Math.random() * chars.length)]
      part2 += chars[Math.floor(Math.random() * chars.length)]
    }
    return `PHARM-${part1}-${part2}`
  }

  /**
   * Signs a license payload using HMAC-SHA256 with the platform signing secret.
   */
  static signLicense(
    params: Omit<SignedLicensePayload, 'signature' | 'graceUntil'> & { graceUntil?: number }
  ): SignedLicensePayload {
    const graceUntil = params.graceUntil ?? params.validUntil + FIFTEEN_DAYS_MS
    const payloadWithoutSig: Omit<SignedLicensePayload, 'signature'> = {
      tenantId: params.tenantId,
      businessName: params.businessName,
      plan: params.plan,
      deviceFingerprint: params.deviceFingerprint,
      issuedAt: params.issuedAt,
      validUntil: params.validUntil,
      graceUntil,
    }

    const dataToSign = JSON.stringify(payloadWithoutSig)
    const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(dataToSign).digest('hex')

    return {
      ...payloadWithoutSig,
      signature,
    }
  }

  /**
   * Activates an un-paired activation key and binds it to the requesting device fingerprint.
   */
  async activateDevice(params: {
    activationKey: string
    deviceFingerprint: string
    deviceName?: string
  }): Promise<{
    license: SignedLicensePayload
    tenant: typeof cloudTenants.$inferSelect
  }> {
    const db = getDb()
    const cleanKey = params.activationKey.trim().toUpperCase()

    // 1. Find license record
    const licenseRecords = await db
      .select()
      .from(cloudTenantLicenses)
      .where(eq(cloudTenantLicenses.activationKey, cleanKey))
      .limit(1)

    if (licenseRecords.length === 0) {
      throw new Error('Invalid activation key. Please verify the code and try again.')
    }

    const licenseRecord = licenseRecords[0]
    if (!licenseRecord.isActive) {
      throw new Error('This license has been deactivated. Please contact support.')
    }

    // 2. Hardware binding check
    if (licenseRecord.deviceFingerprint && licenseRecord.deviceFingerprint !== params.deviceFingerprint) {
      throw new Error(
        'This activation key is already bound to another counter computer. Each counter license is restricted to 1 machine. Contact support to transfer devices.'
      )
    }

    // 3. Find tenant
    const tenants = await db
      .select()
      .from(cloudTenants)
      .where(eq(cloudTenants.tenantId, licenseRecord.tenantId))
      .limit(1)

    if (tenants.length === 0) {
      throw new Error('Associated pharmacy tenant was not found.')
    }

    const tenant = tenants[0]
    const now = Date.now()

    // 4. Generate signed license token
    const signedToken = CloudLicensingService.signLicense({
      tenantId: tenant.tenantId,
      businessName: tenant.businessName,
      plan: tenant.subscriptionPlan as 'trial' | 'standard' | 'enterprise',
      deviceFingerprint: params.deviceFingerprint,
      issuedAt: now,
      validUntil: tenant.currentPeriodEndsAt,
      graceUntil: tenant.gracePeriodEndsAt,
    })

    // 5. Update license record with hardware binding
    await db
      .update(cloudTenantLicenses)
      .set({
        deviceFingerprint: params.deviceFingerprint,
        deviceName: params.deviceName || 'Counter-PC',
        signedToken: JSON.stringify(signedToken),
        activatedAt: licenseRecord.activatedAt || now,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(cloudTenantLicenses.id, licenseRecord.id))

    return {
      license: signedToken,
      tenant,
    }
  }

  /**
   * Background heartbeat check: records device presence and returns an updated token if renewed.
   */
  async processHeartbeat(params: {
    deviceFingerprint: string
  }): Promise<{
    acknowledged: boolean
    renewed: boolean
    license?: SignedLicensePayload
    status?: string
  }> {
    const db = getDb()
    const now = Date.now()

    const licenses = await db
      .select()
      .from(cloudTenantLicenses)
      .where(and(eq(cloudTenantLicenses.deviceFingerprint, params.deviceFingerprint), eq(cloudTenantLicenses.isActive, 1)))
      .limit(1)

    if (licenses.length === 0) {
      return { acknowledged: false, renewed: false }
    }

    const licenseRecord = licenses[0]

    // Update last seen
    await db
      .update(cloudTenantLicenses)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(cloudTenantLicenses.id, licenseRecord.id))

    // Check if tenant subscription end date is newer than what was signed
    const tenants = await db
      .select()
      .from(cloudTenants)
      .where(eq(cloudTenants.tenantId, licenseRecord.tenantId))
      .limit(1)

    if (tenants.length === 0) {
      return { acknowledged: true, renewed: false }
    }

    const tenant = tenants[0]
    let storedToken: SignedLicensePayload | null = null
    try {
      if (licenseRecord.signedToken) {
        storedToken = JSON.parse(licenseRecord.signedToken) as SignedLicensePayload
      }
    } catch {
      /* ignore */
    }

    // If tenant validity was extended in cloud beyond currently signed token:
    if (!storedToken || storedToken.validUntil < tenant.currentPeriodEndsAt) {
      const newSignedToken = CloudLicensingService.signLicense({
        tenantId: tenant.tenantId,
        businessName: tenant.businessName,
        plan: tenant.subscriptionPlan as 'trial' | 'standard' | 'enterprise',
        deviceFingerprint: params.deviceFingerprint,
        issuedAt: now,
        validUntil: tenant.currentPeriodEndsAt,
        graceUntil: tenant.gracePeriodEndsAt,
      })

      await db
        .update(cloudTenantLicenses)
        .set({ signedToken: JSON.stringify(newSignedToken), updatedAt: now })
        .where(eq(cloudTenantLicenses.id, licenseRecord.id))

      return {
        acknowledged: true,
        renewed: true,
        license: newSignedToken,
        status: tenant.status,
      }
    }

    return {
      acknowledged: true,
      renewed: false,
      status: tenant.status,
    }
  }

  /**
   * Renews or extends a pharmacy's subscription (Manual Admin Option C or Webhook Option B).
   */
  async renewTenantSubscription(params: {
    tenantId: string
    months: number
    paymentMethod: 'bank_transfer' | 'telebirr' | 'chapa' | 'cash'
    referenceNumber: string
    amountCents: number
    recordedBy?: string
    notes?: string
  }): Promise<{
    tenant: typeof cloudTenants.$inferSelect
    extendedUntil: number
    graceUntil: number
  }> {
    const db = getDb()
    const now = Date.now()

    const tenants = await db
      .select()
      .from(cloudTenants)
      .where(eq(cloudTenants.tenantId, params.tenantId))
      .limit(1)

    if (tenants.length === 0) {
      throw new Error('Tenant not found')
    }

    const tenant = tenants[0]
    // Extend from current period end or now (whichever is greater)
    const baseDate = Math.max(now, tenant.currentPeriodEndsAt)
    const newPeriodEndsAt = baseDate + params.months * THIRTY_DAYS_MS
    const newGraceEndsAt = newPeriodEndsAt + FIFTEEN_DAYS_MS

    // Update tenant status to active
    await db
      .update(cloudTenants)
      .set({
        status: 'active',
        currentPeriodEndsAt: newPeriodEndsAt,
        gracePeriodEndsAt: newGraceEndsAt,
        updatedAt: now,
      })
      .where(eq(cloudTenants.tenantId, params.tenantId))

    // Record payment audit trail
    await db.insert(subscriptionPayments).values({
      tenantId: params.tenantId,
      amountCents: params.amountCents,
      currency: 'ETB',
      paymentMethod: params.paymentMethod,
      referenceNumber: params.referenceNumber,
      periodExtendedMonths: params.months,
      status: 'completed',
      recordedBy: params.recordedBy || 'admin',
      notes: params.notes,
      createdAt: now,
    })

    const updated = (
      await db.select().from(cloudTenants).where(eq(cloudTenants.tenantId, params.tenantId)).limit(1)
    )[0]

    return {
      tenant: updated,
      extendedUntil: newPeriodEndsAt,
      graceUntil: newGraceEndsAt,
    }
  }
}

export const cloudLicensingService = new CloudLicensingService()
