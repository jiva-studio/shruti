import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OtpConfig } from '@lectorium/api/configs';
import { RedisService } from '@lectorium/api/shared/services';
import { Otp, OtpStorageKey, OtpType } from '@lectorium/protocol';

/**
 * Service for generating and validating one-time passwords (OTPs) using Redis.
 */
@Injectable()
export class OtpService {
  /**
   * Constructs an instance of the OTP service.
   *
   * @param redisConfig - The configuration for connecting to the Redis server.
   */
  constructor(
    private readonly redis: RedisService,
    @Inject(OtpConfig.KEY)
    private readonly otpConfig: ConfigType<typeof OtpConfig>,
  ) {}

  /**
   * Generates a one-time password for the given login and type.
   *
   * @param login - The login identifier for which the OTP is being generated.
   * @param type - The type or method of OTP generation (e.g., SMS, email).
   * @returns A promise that resolves to the generated OTP code as a string.
   */
  async generate(login: string, type: OtpType): Promise<Otp> {
    const otp: Otp = {
      code: this.generateCode(),
      type: type,
    };
    await this.redis.set(OtpStorageKey(login), JSON.stringify(otp), 300);
    return otp;
  }

  /**
   * Checks if the one-time password for the given login has expired.
   *
   * @param login - The login identifier for which to check the OTP expiration.
   * @returns A promise that resolves to a boolean indicating whether the OTP has expired.
   */
  async isExpired(login: string): Promise<boolean> {
    const key = OtpStorageKey(login);
    return !(await this.redis.exists(key));
  }

  async getTimeToLive(login: string): Promise<number> {
    const key = OtpStorageKey(login);
    return await this.redis.ttl(key);
  }

  /**
   * Validates the provided OTP code for the given login.
   *
   * @param login - The login identifier for which the OTP code is being validated.
   * @param code - The OTP code to validate.
   * @returns A promise that resolves to the Otp object if the code is
   *          correct, or undefined if the code is incorrect or not found.
   *
   * @remarks
   * The OTP code is expired immediately upon successful validation to
   * prevent replay attacks and multiple logins.
   */
  async validate(login: string, code: string): Promise<Otp | undefined> {
    const key = OtpStorageKey(login);
    const stored: Otp = JSON.parse((await this.redis.get(key)) || 'null');
    if (!stored) return undefined;

    // if code is correct, expire it immediately
    // to prevent replay attacks and multiple logins
    if (code === stored.code) {
      await this.redis.del(key);
      return stored;
    }

    // if code is incorrect, return undefined
    return undefined;
  }

  /**
   * Generates a random OTP  code based on the configured
   * alphabet and length.
   *
   * @returns A randomly generated OTP code.
   */
  private generateCode(): string {
    const characters = this.otpConfig.alphabet;
    const length = this.otpConfig.length;
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(
        Math.floor(Math.random() * characters.length),
      );
    }
    return result;
  }
}
