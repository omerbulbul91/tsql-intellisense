import { SqlFormatter } from '../src/formatter/sqlFormatter';
import { StyleLoader } from '../src/formatter/styleLoader';

const input = `ALTER PROC  dbo.Sp_Rn_Crm_ActivityActive
    @ActivityId int
As
Set NoCount On
Begin
    /*
        Yazan\t: tersoy
        Tarih\t: 26.08.2024
        Açıklama:
    */
    Begin Try
        Declare @ActivityTypeId Int, @ActivityStatuId int, @IsActive Bit, @DocumentTypeId Int, @FirmId int,@FirmName NVarchar(150),@DocumentTypeName NVarchar(150),
\t\t@ActiveActivityId int , @ActiveActivityNo NVarchar(40)
\t\t

        Select  @ActivityTypeId = CA.ActivityTypeId, @ActivityStatuId = CA.ActivityStatuId, @IsActive = ISNULL(CA.IsActive, 0),
                @DocumentTypeId = CA.DocumentTypeId, @FirmId = CA.FirmId,@FirmName =FF.FirmName,@DocumentTypeName= CDT.DocumentTypeName
        From    dbo.Tb_RnPj_Crm_Activities CA
\t\tInner Join dbo.Tb_Rn_Finance_Firms FF On FF.FirmId = CA.FirmId
\t\tleft Join dbo.Tb_RnPj_Crm_DocumentTypes CDT On CDT.DocumentTypeId = CA.DocumentTypeId
        Where   CA.ActivityId = @ActivityId

\t\tIf @ActivityStatuId = 4 Begin
\t\t\tRaiserror('Reddedilen tekliflerde işlem yapılamaz. İlk olarak reddedilen teklifin redini kaldırın',16,1)
\t\tEnd

        If @ActivityTypeId = 1 Begin
            Raiserror('Müşteri ziyaretini onaylayamazsınız...', 16, 1)
        End

\t\tIf @ActivityTypeId = 2 Begin

\t\tSelect @ActiveActivityId = CA.ActivityId ,@ActiveActivityNo = CA.ActivityNo
\t\tFrom dbo.Tb_RnPj_Crm_Activities CA
\t\tWhere CA.DocumentTypeId = @DocumentTypeId And CA.FirmId = @FirmId And CA.IsActive = 1

        If @IsActive = 0 Begin
   --         If Exists (Select  * From  dbo.Tb_RnPj_Crm_Activities CA
\t\t\t--Where CA.DocumentTypeId = @DocumentTypeId And CA.FirmId = @FirmId And CA.IsActive = 1 And CA.ActivityTypeId = 2) Begin
   --             Raiserror('%s firmasının %s evrak tipinden aktif olan %s numaralı teklifinin aktifliğini kaldırınız... ', 16, 1,@FirmName,@DocumentTypeName,@ActiveActivityNo)
   --         End
          --  Else Begin
                Update  dbo.Tb_RnPj_Crm_Activities Set  IsActive = 1, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
          --  End
        End
        Else Begin
            Update  dbo.Tb_RnPj_Crm_Activities Set  IsActive = 0, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
        End
\t\tEnd
\t\t
\t\tIf @ActivityTypeId =3 Begin
\t\t  If @IsActive = 0 Begin
   --         If Exists (Select  * From  dbo.Tb_RnPj_Crm_Activities CA
\t\t\t--Where   CA.FirmId = @FirmId And CA.IsActive = 1 And CA.ActivityTypeId=3) Begin
   --             Raiserror('%s firmasının  aktif olan %s numaralı sözleşmenin aktifliğini kaldırınız... ', 16, 1,@FirmName,@DocumentTypeName,@ActiveActivityNo)
   --         End
            Begin
                Update  dbo.Tb_RnPj_Crm_Activities Set  IsActive = 1, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
            End
        End
        Else Begin
            Update  dbo.Tb_RnPj_Crm_Activities Set  IsActive = 0, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
        End
\t\tEnd

    End Try
    Begin Catch
        Declare @ObjectName NVarchar(126);
        Set @ObjectName = OBJECT_NAME(@@PROCID);
        Execute SP100_GenerateError @ObjectName;
    End Catch
End`;

const expected = `Create Or Alter Proc dbo.Sp_Rn_Crm_ActivityActive
    @ActivityId Int
As
Set NoCount On

Begin
    /*
        Yazan\t: tersoy
        Tarih\t: 26.08.2024
        Açıklama:
    */
    Begin Try
        Declare @ActivityTypeId Int, @ActivityStatuId Int, @IsActive Bit, @DocumentTypeId Int, @FirmId Int
              , @FirmName NVarchar(150), @DocumentTypeName NVarchar(150), @ActiveActivityId Int
              , @ActiveActivityNo NVarchar(40)

        Select  @ActivityTypeId = CA.ActivityTypeId, @ActivityStatuId = CA.ActivityStatuId
              , @IsActive = ISNULL(CA.IsActive, 0), @DocumentTypeId = CA.DocumentTypeId, @FirmId = CA.FirmId
              , @FirmName = FF.FirmName, @DocumentTypeName = CDT.DocumentTypeName
        From    dbo.Tb_RnPj_Crm_Activities CA
                Inner Join dbo.Tb_Rn_Finance_Firms FF On
                           FF.FirmId = CA.FirmId
                Left Join dbo.Tb_RnPj_Crm_DocumentTypes CDT On
                          CDT.DocumentTypeId = CA.DocumentTypeId
        Where   CA.ActivityId = @ActivityId

        If @ActivityStatuId = 4 Begin
            Raiserror('Reddedilen tekliflerde işlem yapılamaz. İlk olarak reddedilen teklifin redini kaldırın', 16, 1)
        End

        If @ActivityTypeId = 1 Begin
            Raiserror('Müşteri ziyaretini onaylayamazsınız...', 16, 1)
        End

        If @ActivityTypeId = 2 Begin
            Select  @ActiveActivityId = CA.ActivityId, @ActiveActivityNo = CA.ActivityNo
            From    dbo.Tb_RnPj_Crm_Activities CA
            Where   CA.DocumentTypeId = @DocumentTypeId And CA.FirmId = @FirmId And CA.IsActive = 1

            If @IsActive = 0 Begin
                --         If Exists (Select  * From  dbo.Tb_RnPj_Crm_Activities CA
                --Where CA.DocumentTypeId = @DocumentTypeId And CA.FirmId = @FirmId And CA.IsActive = 1 And CA.ActivityTypeId = 2) Begin
                --             Raiserror('%s firmasının %s evrak tipinden aktif olan %s numaralı teklifinin aktifliğini kaldırınız... ', 16, 1,@FirmName,@DocumentTypeName,@ActiveActivityNo)
                --         End
                --  Else Begin
                Update dbo.Tb_RnPj_Crm_Activities Set IsActive = 1, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
                --  End
            End
            Else Begin
                Update dbo.Tb_RnPj_Crm_Activities Set IsActive = 0, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
            End
        End

        If @ActivityTypeId = 3 Begin
            If @IsActive = 0 Begin
                --         If Exists (Select  * From  dbo.Tb_RnPj_Crm_Activities CA
                --Where   CA.FirmId = @FirmId And CA.IsActive = 1 And CA.ActivityTypeId=3) Begin
                --             Raiserror('%s firmasının  aktif olan %s numaralı sözleşmenin aktifliğini kaldırınız... ', 16, 1,@FirmName,@DocumentTypeName,@ActiveActivityNo)
                --         End
                Begin
                    Update dbo.Tb_RnPj_Crm_Activities Set IsActive = 1, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
                End
            End
            Else Begin
                Update dbo.Tb_RnPj_Crm_Activities Set IsActive = 0, ByPassTrig = ByPassTrig Where ActivityId = @ActivityId
            End
        End
    End Try
    Begin Catch
        Declare @ObjectName NVarchar(126);

        Set @ObjectName = OBJECT_NAME(@@PROCID);

        Execute dbo.SP100_GenerateError @ObjectName;
    End Catch
End
Go
`;

async function run() {
    const styleLoader = new StyleLoader();
    const formatter = new SqlFormatter(styleLoader);
    const result = formatter.format(input);

    const expectedLines = expected.split('\n');
    const resultLines = result.split('\n');

    let passed = 0;
    let failed = 0;
    const maxLines = Math.max(expectedLines.length, resultLines.length);

    for (let i = 0; i < maxLines; i++) {
        const exp = expectedLines[i] ?? '(missing)';
        const got = resultLines[i] ?? '(missing)';
        if (exp === got) {
            passed++;
        } else {
            console.log(`  ❌ Line ${i + 1}:`);
            console.log(`     Expected: ${JSON.stringify(exp)}`);
            console.log(`     Got:      ${JSON.stringify(got)}`);
            failed++;
        }
    }

    console.log(`\nSP Format: ${passed} lines match, ${failed} lines differ`);
    if (failed > 0) {
        console.log('\n=== FULL RESULT ===');
        console.log(result);
    }
}

run();
