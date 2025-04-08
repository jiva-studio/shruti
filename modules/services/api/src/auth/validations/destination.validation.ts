import { Injectable } from '@nestjs/common';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'destination-exists' })
@Injectable()
export class IsDestinationCorrectConstraint
  implements ValidatorConstraintInterface
{
  constructor() {}

  validate(value: string): boolean {
    if (!value) {
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;

    if (emailRegex.test(value)) {
      return true;
    } else if (phoneRegex.test(value)) {
      return true;
    }
    return false;
  }

  defaultMessage(validationArguments?: ValidationArguments): string {
    if (!validationArguments?.value) {
      return `${validationArguments?.property} is required`;
    }
    return `'${validationArguments.value}' is invalid`;
  }
}

export function IsDestinationCorrect(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsDestinationCorrectConstraint,
    });
  };
}
