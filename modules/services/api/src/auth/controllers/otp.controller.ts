import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { MailerService } from '@nestjs-modules/mailer';
import * as dto from '@lectorium/api/auth/dto';
import * as dtoShared from '@lectorium/api/shared/dto';
import { OtpService } from '@lectorium/api/auth/services';
import { MailerConfig } from '@lectorium/api/configs';
import { OtpType, Routes } from '@lectorium/protocol';

@Controller()
@ApiTags('🎟️ Authentication :: One-Time Password')
export class OtpController {
  constructor(
    private readonly otpService: OtpService,
    private readonly mailService: MailerService,
    @Inject(MailerConfig.KEY)
    private readonly mailerConfig: ConfigType<typeof MailerConfig>,
  ) {}

  /* -------------------------------------------------------------------------- */
  /*                               POST /auth/otp                               */
  /* -------------------------------------------------------------------------- */

  @Post(Routes().otp.root())
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generates OTP and sends it to the user',
    operationId: 'otp::generate',
    description:
      `Generates OTP and sends it to the user.\n\n` +
      `Returns success message if the OTP has been sent. If the OTP has ` +
      `already been generated and is still valid, returns an error message.`,
  })
  @ApiBody({ type: dto.GetOtpRequest })
  @ApiOkResponse({
    type: dto.GetOtpResponse,
    description: 'OTP has been sent to the user.',
  })
  @ApiTooManyRequestsResponse({
    type: dtoShared.ErrorResponse,
    description: 'An OTP has already been generated and is still valid.',
  })
  async generateOtpCode(
    @Body() request: dto.GetOtpRequest,
  ): Promise<dto.GetOtpResponse> {
    // check if an OTP has already been generated and is still valid
    const otpExireIn = await this.otpService.getTimeToLive(request.destination);
    if (otpExireIn > 0) {
      throw new HttpException(
        new dto.GetOtpResponse({
          success: false,
          message:
            `An OTP has already been generated and is still valid. ` +
            `Try in ${otpExireIn} seconds.`,
        }),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // generate a new OTP
    const otp = await this.otpService.generate(
      request.destination,
      request.type,
    );

    // send the OTP to the user
    if (request.type === OtpType.Email) {
      // TODO: select template based on the users preferred language
      // TODO: inject or save images from template somwhere
      const lang = 'en';
      await this.mailService.sendMail({
        from: {
          name: this.mailerConfig.from.name,
          address: this.mailerConfig.from.address,
        },
        to: request.destination,
        subject: 'Your OTP', // TODO: change topic
        template: `${lang}/otp`,
        context: {
          code: otp.code,
        },
      });
    } else if (request.type === OtpType.Sms) {
      // send the OTP to the phone number
    }

    // return success message
    return new dto.GetOtpResponse();
  }
}
