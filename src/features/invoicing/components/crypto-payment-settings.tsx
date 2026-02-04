'use client';

import { useState, useEffect } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info, Loader2, Plus, Trash2, TestTube, Sparkles } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isTestnetEnabled } from '@/lib/crypto/blockchain-monitor';

const cryptoSettingsSchema = z.object({
  cryptoPaymentsEnabled: z.boolean(),
  cryptoMinConfirmations: z.number().min(1).max(100),
  stopReusingAddresses: z.boolean(),
  addressReuseCooldownHours: z.number().min(1).max(168),
  xrpAddresses: z.array(z.string()),
  usdcAddresses: z.array(z.string()),
  usdtAddresses: z.array(z.string()),
  solAddresses: z.array(z.string())
});

type CryptoSettingsFormData = z.infer<typeof cryptoSettingsSchema>;

const SUPPORTED_CRYPTOS = [
  { value: 'xrp', label: 'Ripple (XRP)' },
  { value: 'usdc', label: 'USD Coin (USDC) - Solana' },
  { value: 'usdt', label: 'Tether (USDT) - Solana' },
  { value: 'sol', label: 'Solana (SOL)' }
];

export function CryptoPaymentSettings() {
  const queryClient = useQueryClient();
  const [newAddresses, setNewAddresses] = useState<{
    xrp: string;
    usdc: string;
    usdt: string;
    sol: string;
  }>({
    xrp: '',
    usdc: '',
    usdt: '',
    sol: ''
  });

  // Fetch current crypto settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['crypto-settings'],
    queryFn: async () => {
      const response = await fetch('/api/organizations/crypto');
      if (!response.ok) {
        throw new Error('Failed to fetch crypto settings');
      }
      return response.json();
    }
  });

  // Update crypto settings
  const updateSettings = useMutation({
    mutationFn: async (data: CryptoSettingsFormData) => {
      const response = await fetch('/api/organizations/crypto', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update crypto settings');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['crypto-settings'] });
      toast.success('Crypto payment settings updated successfully');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to update crypto settings');
    }
  });

  const form = useForm<CryptoSettingsFormData>({
    resolver: zodResolver(cryptoSettingsSchema),
    defaultValues: {
      cryptoPaymentsEnabled: false,
      cryptoMinConfirmations: 3,
      stopReusingAddresses: false,
      addressReuseCooldownHours: 24,
      xrpAddresses: [],
      usdcAddresses: [],
      usdtAddresses: [],
      solAddresses: []
    }
  });

  // Update form when data loads
  useEffect(() => {
    if (settings) {
      const wallets = settings.cryptoWallets
        ? JSON.parse(settings.cryptoWallets)
        : {};

      form.reset({
        cryptoPaymentsEnabled: settings.cryptoPaymentsEnabled || false,
        cryptoMinConfirmations: settings.cryptoMinConfirmations || 3,
        stopReusingAddresses: settings.stopReusingAddresses || false,
        addressReuseCooldownHours: settings.addressReuseCooldownHours || 24,
        xrpAddresses: wallets.xrp || [],
        usdcAddresses: wallets.usdc || [],
        usdtAddresses: wallets.usdt || [],
        solAddresses: wallets.sol || []
      });
    }
  }, [settings, form]);

  const onSubmit = (data: CryptoSettingsFormData) => {
    updateSettings.mutate(data);
  };

  const addAddress = (crypto: 'xrp' | 'usdc' | 'usdt' | 'sol') => {
    const address = newAddresses[crypto].trim();
    if (!address) {
      toast.error('Please enter an address');
      return;
    }

    // Basic validation for Solana addresses (base58, 32-44 chars)
    if (['usdc', 'usdt', 'sol'].includes(crypto)) {
      if (address.length < 32 || address.length > 44) {
        toast.error('Invalid Solana address format');
        return;
      }
    }

    const currentAddresses = form.getValues(`${crypto}Addresses` as any) || [];
    if (currentAddresses.includes(address)) {
      toast.error('Address already exists');
      return;
    }

    form.setValue(`${crypto}Addresses` as any, [...currentAddresses, address]);
    setNewAddresses({ ...newAddresses, [crypto]: '' });
  };

  const removeAddress = (
    crypto: 'xrp' | 'usdc' | 'usdt' | 'sol',
    index: number
  ) => {
    const currentAddresses = form.getValues(`${crypto}Addresses` as any) || [];
    form.setValue(
      `${crypto}Addresses` as any,
      currentAddresses.filter((_: any, i: number) => i !== index)
    );
  };

  // Generate crypto account (XRP or Solana)
  const generateAccount = useMutation({
    mutationFn: async ({
      useFaucet,
      cryptocurrency
    }: {
      useFaucet: boolean;
      cryptocurrency: string;
    }) => {
      const response = await fetch('/api/organizations/crypto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useFaucet, cryptocurrency })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          error.error || `Failed to generate ${cryptocurrency} account`
        );
      }
      return response.json();
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['crypto-settings'] });

      const crypto = variables.cryptocurrency.toLowerCase();
      const cryptoKey = crypto as 'xrp' | 'usdc' | 'usdt' | 'sol';

      // Add the generated address to the form
      const currentAddresses =
        form.getValues(`${cryptoKey}Addresses` as any) || [];
      form.setValue(`${cryptoKey}Addresses` as any, [
        ...currentAddresses,
        data.account.address
      ]);

      // Show success message with key info
      const cryptoLabel = crypto.toUpperCase();
      const keyInfo = data.account.seed
        ? `Seed: ${data.account.seed}`
        : data.account.privateKey
          ? `Private Key: ${data.account.privateKey.substring(0, 20)}...`
          : '';

      toast.success(
        `${cryptoLabel} account generated! Address: ${data.account.address.substring(0, 10)}...`,
        {
          description:
            keyInfo +
            (keyInfo
              ? ' - Save this securely!'
              : 'Account generated successfully'),
          duration: 10000
        }
      );
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to generate account');
    }
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className='flex items-center justify-center py-12'>
          <Loader2 className='h-6 w-6 animate-spin' />
        </CardContent>
      </Card>
    );
  }

  return (
    <FormProvider {...form}>
      <div className='space-y-6'>
        {process.env.NODE_ENV === 'development' && (
          <Alert className='border-blue-500 bg-blue-50 dark:bg-blue-950'>
            <Info className='h-4 w-4 text-blue-600' />
            <AlertDescription className='text-blue-800 dark:text-blue-200'>
              💡 Development Mode: Enable TEST MODE in .env to simulate
              transactions without blockchain.
            </AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Crypto Payment Settings</CardTitle>
            <CardDescription>
              Configure cryptocurrency payment options for your organization
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-6'>
            <FormField
              control={form.control}
              name='cryptoPaymentsEnabled'
              render={({ field }) => (
                <FormItem className='flex flex-row items-center justify-between rounded-lg border p-4'>
                  <div className='space-y-0.5'>
                    <FormLabel className='text-base'>
                      Enable Crypto Payments
                    </FormLabel>
                    <FormDescription>
                      Allow customers to pay invoices with cryptocurrency
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            {form.watch('cryptoPaymentsEnabled') && (
              <>
                <FormField
                  control={form.control}
                  name='cryptoMinConfirmations'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Minimum Confirmations</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          min={1}
                          max={100}
                          {...field}
                          onChange={(e) =>
                            field.onChange(parseInt(e.target.value) || 3)
                          }
                        />
                      </FormControl>
                      <FormDescription>
                        Number of blockchain confirmations required before
                        payment is confirmed (default: 3)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name='stopReusingAddresses'
                  render={({ field }) => (
                    <FormItem className='flex flex-row items-center justify-between rounded-lg border p-4'>
                      <div className='space-y-0.5'>
                        <FormLabel className='text-base'>
                          Stop Reusing Addresses
                        </FormLabel>
                        <FormDescription>
                          Never reuse addresses for better privacy (requires
                          more addresses)
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {!form.watch('stopReusingAddresses') && (
                  <FormField
                    control={form.control}
                    name='addressReuseCooldownHours'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Address Reuse Cooldown (Hours)</FormLabel>
                        <FormControl>
                          <Input
                            type='number'
                            min={1}
                            max={168}
                            {...field}
                            onChange={(e) =>
                              field.onChange(parseInt(e.target.value) || 24)
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          Hours before an address can be reused (default: 24)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <Alert>
                  <Info className='h-4 w-4' />
                  <AlertDescription>
                    Add wallet addresses for each cryptocurrency you want to
                    accept. The system will rotate through these addresses for
                    each payment.
                    <br />
                    <br />
                    <strong>Solana addresses:</strong> For USDC, USDT, and SOL,
                    enter your Solana wallet address (base58 format, 32-44
                    characters). The system will automatically derive the
                    Associated Token Account (ATA) for token payments.
                  </AlertDescription>
                </Alert>

                {SUPPORTED_CRYPTOS.map((crypto) => {
                  const cryptoKey = crypto.value as
                    | 'xrp'
                    | 'usdc'
                    | 'usdt'
                    | 'sol';
                  const addresses =
                    form.watch(`${cryptoKey}Addresses` as any) || [];
                  const isTestnet = isTestnetEnabled();

                  return (
                    <div key={crypto.value} className='space-y-2'>
                      <div className='flex items-center justify-between'>
                        <Label>{crypto.label} Addresses</Label>
                        {(cryptoKey === 'xrp' ||
                          ['usdc', 'usdt', 'sol'].includes(cryptoKey)) && (
                          <Button
                            type='button'
                            onClick={() =>
                              generateAccount.mutate({
                                useFaucet: isTestnet,
                                cryptocurrency: cryptoKey
                              })
                            }
                            disabled={generateAccount.isPending}
                            variant='outline'
                            size='sm'
                            className='gap-2'
                          >
                            {generateAccount.isPending ? (
                              <>
                                <Loader2 className='h-3 w-3 animate-spin' />
                                Generating...
                              </>
                            ) : (
                              <>
                                <Sparkles className='h-3 w-3' />
                                {isTestnet
                                  ? `Generate Testnet ${cryptoKey.toUpperCase()} Account`
                                  : `Generate ${cryptoKey.toUpperCase()} Account`}
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                      <div className='space-y-2'>
                        {addresses.map((address: string, index: number) => (
                          <div key={index} className='flex items-center gap-2'>
                            <code className='bg-muted flex-1 rounded p-2 text-xs'>
                              {address}
                            </code>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon'
                              onClick={() => removeAddress(cryptoKey, index)}
                            >
                              <Trash2 className='h-4 w-4' />
                            </Button>
                          </div>
                        ))}
                        <div className='flex gap-2'>
                          <Input
                            placeholder={`Enter ${crypto.label} address`}
                            value={newAddresses[cryptoKey]}
                            onChange={(e) =>
                              setNewAddresses({
                                ...newAddresses,
                                [cryptoKey]: e.target.value
                              })
                            }
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addAddress(cryptoKey);
                              }
                            }}
                          />
                          <Button
                            type='button'
                            onClick={() => addAddress(cryptoKey)}
                            variant='outline'
                          >
                            <Plus className='h-4 w-4' />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </CardContent>
        </Card>

        <div className='flex justify-end'>
          <Button
            type='button'
            onClick={form.handleSubmit(onSubmit)}
            disabled={updateSettings.isPending}
          >
            {updateSettings.isPending ? (
              <>
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                Saving...
              </>
            ) : (
              'Save Settings'
            )}
          </Button>
        </div>
      </div>
    </FormProvider>
  );
}
